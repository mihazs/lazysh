import type {Page} from '@playwright/test';

/** What the Android shell reports on a Samsung One UI phone with the back gesture on: 32 dp Back zones and a 24 dp Home zone. */
export const oneUi={left:32,right:32,bottom:20,mandatoryBottom:24,navigation:'gesture'};
/** The three-button navigation report: nothing is reserved at the edges. */
export const threeButtons={left:0,right:0,bottom:0,mandatoryBottom:0,navigation:'buttons'};
/** Plays the window event the shell dispatches whenever the system gesture zones change. */
export const reportGestureInsets=(page:Page,detail:object)=>page.evaluate(value=>{window.dispatchEvent(new CustomEvent('lazysh-gesture-insets',{detail:value}));},detail);
