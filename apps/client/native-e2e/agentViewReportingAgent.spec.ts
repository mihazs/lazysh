import {reportingAgentCases} from './agentViewScenarios';
import {TmuxReportingAgent} from './reportingAgent';
import {ownedSshGui} from './sshUi';

const fixture=ownedSshGui();
reportingAgentCases('a hook-reporting agent in a real tmux pane',()=>TmuxReportingAgent.start(fixture));
