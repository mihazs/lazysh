import {afterEach,beforeEach} from 'vitest';

/**
 * Fails a test that makes jsdom compute more than `max` styles. Every role or label query computes the
 * style of each element it considers, so the count is the cost of the queries: the Preferences suites
 * once timed out at 5 s on shared runners because each query walked every mounted settings page. The
 * count depends only on the DOM and the queries, not on machine speed or load, so the guard cannot
 * flake. Use it in synchronous suites: a `waitFor` poll repeats its queries while it waits.
 */
export function budgetStyleLookups(max:number) {
  let lookups=0;
  let real:typeof window.getComputedStyle;
  beforeEach(()=>{
    lookups=0;real=window.getComputedStyle;
    window.getComputedStyle=((...args:Parameters<typeof real>)=>{lookups++;return real.apply(window,args);}) as typeof real;
  });
  afterEach(()=>{
    window.getComputedStyle=real;
    if(lookups>max)throw new Error(`The test computed ${lookups} styles, over its budget of ${max}: scope queries to the page under test, or raise the budget if the page really grew.`);
  });
}
