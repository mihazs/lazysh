import { join } from 'node:path';
import { project } from './gitFixture';

/** A GitHub Actions context subset; absent values evaluate as null, like an unset property. */
export type Context = Record<string, any>;
export type RunnerJob = {
  file: string; id: string; job: any; context: Context; rows: Context[]; queueEntry: number;
};

const parsed = new Map<string, any>();
export async function document(path: string) {
  if (!parsed.has(path)) parsed.set(path, Bun.YAML.parse(await Bun.file(join(project, path)).text()));
  return parsed.get(path);
}

function lookup(context: Context, path: string) {
  const [root, ...keys] = path.split('.');
  // Release graphs model the success path: every needed job succeeded and admitted the release.
  if (root === 'needs' && context.needs === undefined) return keys.at(-1) === 'result' ? 'success' : keys[1] === 'outputs' ? 'true' : null;
  let value = context[root];
  for (const key of keys) value = value == null ? null : value[key];
  return value ?? null;
}

// Actions equality: same-type values compare directly (strings ignore case); otherwise both
// sides coerce to numbers, so an undeclared input (null) equals ''.
function equal(left: unknown, right: unknown) {
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase();
  if (typeof left === typeof right && left !== null && right !== null) return left === right;
  const number = (value: unknown) => value === null ? 0 : typeof value === 'boolean' ? Number(value)
    : typeof value === 'string' ? (value.trim() === '' ? 0 : Number(value)) : Number(value);
  return number(left) === number(right);
}

const functions: Record<string, () => boolean> = { always: () => true, success: () => true, cancelled: () => false, failure: () => false };

/** Evaluate the expression subset these workflows use: contexts, literals, ==, !=, !, &&, || and status functions. */
export function evaluate(expression: unknown, context: Context): unknown {
  if (typeof expression !== 'string') return expression;
  const whole = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(expression.trim());
  const source = whole ? whole[1] : expression;
  const tokens = source.match(/'(?:[^']|'')*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.-]*(?:\(\))?|-?\d+(?:\.\d+)?|\S/g) ?? [];
  let index = 0;
  const peek = () => tokens[index];
  const take = (expected?: string) => {
    const token = tokens[index++];
    if (expected !== undefined && token !== expected) throw new Error(`Unsupported expression: ${source}`);
    return token;
  };
  const primary = (): unknown => {
    const token = take();
    if (token === '!') return !primary();
    if (token === '(') { const value = or(); take(')'); return value; }
    if (token?.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === 'null') return null;
    if (/^-?\d/.test(token ?? '')) return Number(token);
    if (token?.endsWith('()') && Object.hasOwn(functions, token.slice(0, -2))) return functions[token.slice(0, -2)]();
    if (/^(github|inputs|steps|needs|env|runner|matrix|vars|secrets)\./.test(token ?? '')) return lookup(context, token!);
    throw new Error(`Unsupported expression: ${source}`);
  };
  const comparison = (): unknown => {
    let value = primary();
    while (peek() === '==' || peek() === '!=') value = take() === '==' ? equal(value, primary()) : !equal(value, primary());
    return value;
  };
  const and = (): unknown => { let value = comparison(); while (peek() === '&&') { take(); const right = comparison(); value = value ? right : value; } return value; };
  const or = (): unknown => { let value = and(); while (peek() === '||') { take(); const right = and(); value = value ? value : right; } return value; };
  const value = or();
  if (index !== tokens.length) throw new Error(`Unsupported expression: ${source}`);
  return value;
}

/** Interpolate `${{ }}` segments inside a string value, as Actions does for `with` and `name`. */
export function interpolate(value: unknown, context: Context): unknown {
  if (typeof value !== 'string' || !value.includes('${{')) return value;
  if (/^\$\{\{[\s\S]*\}\}$/.test(value.trim()) && value.trim().indexOf('${{', 1) < 0) return evaluate(value, context);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, inner) => String(evaluate(inner, context)));
}

function matrixRows(job: any): Context[] {
  const matrix = job.strategy?.matrix;
  if (!matrix) return [{}];
  let rows: Context[] = [{}];
  for (const [key, values] of Object.entries<any>(matrix)) {
    if (key === 'include' || key === 'exclude') continue;
    rows = rows.flatMap(row => values.map((value: unknown) => ({ ...row, [key]: value })));
  }
  if (matrix.include) rows = Object.keys(matrix).some(key => key !== 'include') ? rows : matrix.include;
  return rows;
}

/**
 * Expand a workflow (recursively through local reusable workflows) for one event and return each
 * runner job that would start, with its runner count and its position in the runner queue: the
 * number of sequential queue entries, counted from the event, after which the job can start.
 */
export async function runnerJobs(file: string, context: Context, offset = 0): Promise<RunnerJob[]> {
  const workflow = await document(file);
  const result: RunnerJob[] = [];
  const finish = new Map<string, number>();
  const visit = async (id: string): Promise<number> => {
    if (finish.has(id)) return finish.get(id)!;
    const job = workflow.jobs[id];
    const needs: string[] = [job.needs ?? []].flat();
    let start = offset;
    for (const need of needs) start = Math.max(start, await visit(need));
    let end = start;
    if (job.if === undefined || evaluate(job.if, context)) {
      if (job.uses) {
        const called = job.uses.replace(/^\.\//, '');
        const declared = (await document(called)).on.workflow_call?.inputs ?? {};
        const inputs = Object.fromEntries(Object.entries<any>(declared).map(([name, spec]) => [name,
          name in (job.with ?? {}) ? interpolate(job.with[name], context) : spec.default ?? null]));
        const inner = await runnerJobs(called, { ...context, inputs }, start);
        result.push(...inner);
        end = Math.max(start, ...inner.map(entry => entry.queueEntry));
      } else {
        end = start + 1;
        result.push({ file, id, job, context, rows: matrixRows(job), queueEntry: end });
      }
    }
    finish.set(id, end);
    return end;
  };
  for (const id of Object.keys(workflow.jobs)) await visit(id);
  return result;
}

/** Resolve a job's executed steps, expanding local composite actions with their evaluated inputs. */
export async function executedSteps(steps: any[], context: Context): Promise<{ step: any; context: Context }[]> {
  const result: { step: any; context: Context }[] = [];
  for (const step of steps) {
    if (step.if !== undefined && !evaluate(step.if, context)) continue;
    result.push({ step, context });
    if (typeof step.uses === 'string' && step.uses.startsWith('./')) {
      const action = await document(join(step.uses.slice(2), 'action.yml'));
      const inputs = Object.fromEntries(Object.entries<any>(action.inputs ?? {}).map(([name, spec]) => [name,
        String(name in (step.with ?? {}) ? interpolate(step.with[name], context) : spec.default ?? '')]));
      result.push(...await executedSteps(action.runs.steps, { ...context, inputs }));
    }
  }
  return result;
}

export const releasePush: Context = { github: { event_name: 'push', ref: 'refs/heads/main' }, inputs: {} };
