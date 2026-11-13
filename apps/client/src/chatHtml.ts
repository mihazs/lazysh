import type {Options} from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import {webUrl} from './webPage';

/** What agents and people write as HTML in a message: structure and emphasis only. No form controls, media, style or
 * scripting elements, and no attribute that can style, script, load or overlay (`id`, `class`, `style`, `on*`, `srcset`, `target`). */
const tagNames = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'samp', 'abbr', 'cite', 'q',
  'details', 'summary', 'figure', 'figcaption', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'img'];
const cells = ['colSpan', 'rowSpan'];
const schema = {
  tagNames,
  // Text outside the list stays visible (see `literalTags`); an element that slips past that loses its tag, and these lose their content too.
  strip: ['script', 'style', 'template', 'noscript', 'title', 'textarea', 'xmp', 'plaintext'],
  attributes: {
    a: ['href', 'title'], img: ['src', 'alt', 'title'], abbr: ['title'], ol: ['start'], details: ['open'], th: cells, td: cells,
    code: [['className', /^language-[\w+#.-]{1,32}$/]],
  },
  protocols: {href: ['http', 'https'], src: ['http', 'https', 'data']},
};

type Node = {type: string; value?: string; children?: Node[]};
const tagToken = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)[^<>]*>/g;
const listed = new Set(tagNames);

const escapes: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;'};
/** Text such as `Vec<String>` or `<file>` is prose, not markup: a tag that is not on the list stays visible as typed, as it did
 * before HTML was rendered. Comments are dropped. The sanitizer after it is the security boundary; this only keeps text. */
function literalTags(node: Node): void {
  for (const child of node.children ?? []) {
    if (child.type === 'raw') child.value = child.value!.replace(tagToken, (tag, name?: string) => !name ? '' : listed.has(name.toLowerCase()) ? tag : tag.replace(/[&<>]/g, char => escapes[char]));
    else literalTags(child);
  }
}

const maxDepth = 32, maxElements = 4000;
const plainText = (node: Node): string => node.type === 'text' ? node.value! : node.children?.map(plainText).join('') ?? '';
/** A message cannot nest or repeat elements without limit: what exceeds the caps is kept as its text. */
function capTree(node: Node, depth = 0, seen = {count: 0}): void {
  node.children = node.children?.map((child): Node => {
    if (child.type !== 'element') return child;
    if (depth >= maxDepth || ++seen.count > maxElements) return {type: 'text', value: plainText(child)};
    capTree(child, depth + 1, seen);
    return child;
  });
}

/** Bigger than any real message; beyond it the text is shown as Markdown without HTML. */
export const maxHtmlLength = 512_000;
/** react-markdown's `rehypePlugins` for messages that may carry HTML. */
export const htmlPlugins: NonNullable<Options['rehypePlugins']> = [
  () => (tree: Node) => literalTags(tree),
  rehypeRaw,
  [rehypeSanitize, schema],
  () => (tree: Node) => capTree(tree),
];

const imageCap = 256 * 1024;
const dataImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** A picture that travels inside the message and is small enough to show without a request. */
export const isDataImage = (value: string) => value.length <= imageCap && dataImage.test(value);

/** Only http(s) links, which open through the app, and embedded pictures survive; anything else becomes an empty address. */
export function urlTransform(url: string, key: string): string {
  return (key === 'src' && isDataImage(url) ? url : webUrl(url)) ?? '';
}

/** True when prose (not code) holds markup that renders, so a plain Markdown message gets no source toggle. */
export function hasHtml(text: string): boolean {
  const prose = text.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\n]*`/g, '');
  return [...prose.matchAll(tagToken)].some(match => match[1] && listed.has(match[1].toLowerCase()));
}
