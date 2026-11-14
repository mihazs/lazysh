// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import './test/appHarness';
import {chatTerminalInputCases} from './test/chatTerminalInputMatrix';

chatTerminalInputCases(['unknown']);
