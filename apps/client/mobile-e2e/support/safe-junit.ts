import JunitReporter from '@wdio/junit-reporter';
import {redactRecoveryKey} from './recovery-key';

export default class SafeJunitReporter extends JunitReporter {
  override write(content: unknown) {
    super.write(typeof content === 'string' ? redactRecoveryKey(content) : content);
  }
}
