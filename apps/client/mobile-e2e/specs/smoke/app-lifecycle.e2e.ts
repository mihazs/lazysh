import {expect} from '@wdio/globals';
import Home from '../../pageobjects/home.page';
import HostEditor from '../../pageobjects/components/host-editor.component';
import HostsList from '../../pageobjects/components/hosts-list.component';
import {relaunchApp, resetApp} from '../../support/app';
import {hostName, readEndpoint} from '../../support/hosts';

describe('App lifecycle helpers', () => {
  const name = hostName('lifecycle');
  after(resetApp);

  it('keeps a saved host when the app is stopped and started again', async () => {
    const {host, port, username} = {...await readEndpoint(), host: '127.0.0.1'};
    await Home.openHostEditor();
    await HostEditor.fill({name, hostname: host, port, username});
    await HostEditor.saveHost();
    await HostsList.in(() => expect(HostsList.connectButton(name)).toBeDisplayed());
    await relaunchApp();
    await HostsList.in(() => expect(HostsList.connectButton(name)).toBeDisplayed());
  });

  it('forgets every host once the app data is cleared', async () => {
    await resetApp();
    await Home.in(() => expect(Home.addFirstHost).toBeDisplayed());
  });
});
