import {reportingAgentCases} from './agentViewScenarios';
import {TmuxReportingAgent} from './reportingAgent';
import {ownedSshGui} from './sshUi';

const fixture=ownedSshGui();
// OpenCode takes every prompt as one bracketed paste and Enter, and its conversation is read from its database.
reportingAgentCases('an OpenCode-style agent in a real tmux pane',()=>TmuxReportingAgent.start(fixture,'opencode'),true);
