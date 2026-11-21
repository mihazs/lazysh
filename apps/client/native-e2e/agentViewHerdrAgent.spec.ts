import {reportingAgentCases} from './agentViewScenarios';
import {HerdrReportingAgent} from './reportingAgent';
import {ownedSshGui} from './sshUi';

const fixture=ownedSshGui();
reportingAgentCases('a reporting agent in a real guarded Herdr pane',()=>HerdrReportingAgent.start(fixture));
