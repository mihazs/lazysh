// Companion output for recorded fixtures; asserted by apps/agent/tests/interaction_cards.rs.
import recorded from './interactionPages.json' with {type:'json'};

const {claudeWaiting:waiting,...pages}=recorded;
export const interactionPages={...pages,
  claudeWaiting:{...recorded.claudeIdle,...waiting,messages:recorded.claudeIdle.messages.slice(0,waiting.messages)}};
