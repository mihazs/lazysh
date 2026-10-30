import {expect,it} from 'vitest';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {NativeGui} from '../native-e2e/fixture';
import {openOwnedSsh,challengeOwnedSsh,disconnectOwnedSsh,ownedSshGui} from '../native-e2e/sshUi';
import {SshFixture} from '../../../tests/support/sshFixture';
import {installedCompanion,publishedCompanion} from './release';
import {companionInstallFailure,companionInstallStage} from '../src/CompanionInstallPanel';

const fixture=ownedSshGui();


it('installs the published verified companion through the actual native GUI and reuses its exact bytes',async()=>{
  // This explicit network-enabled case belongs only on the disposable hosted runner.
  if(process.env.LAZYSH_PUBLISHED_NATIVE_GUI!=='1' || process.env.GITHUB_ACTIONS!=='true' || process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('Published GUI acceptance requires its explicit disposable hosted-runner job');
  if(process.platform!=='linux' || process.arch!=='x64')throw new Error('Published GUI acceptance currently verifies a Linux x64 remote');
  fixture.captureSafe=false;
  const evidence=await publishedCompanion();
  console.info(`Public companion receipt version=${evidence.version} source=${evidence.source} sha256=${evidence.sha256} bytes=${evidence.bytes}`);
  // This network-enabled owner runs outside the baseline's user namespace.
  // Keep actual host-root ownership: a nested user namespace leaves root
  // ancestors unmapped, which the managed namespace correctly rejects.
  const ssh=fixture.ssh=await SshFixture.start(undefined,{companion:true});
  const missing=await ssh.client(true,'if command -v lazysh-agent >/dev/null 2>&1; then exit 1; fi');
  await missing.finish('no preinstalled PATH companion',5000);
  const destination=join(ssh.directory,'data/lazysh/companion/lazysh-agent');
  await expect(lstat(destination)).rejects.toMatchObject({code:'ENOENT'});
  const gui=fixture.gui=await NativeGui.start();
  const {browser,terminal,owner}=await openOwnedSsh(gui,ssh);fixture.captureSafe=true;
  await challengeOwnedSsh(gui,ssh,terminal,owner);
  gui.stage='published companion Agents navigation';
  await (await browser.$('button[aria-label="Agents navigation"]')).click();
  const panel=await browser.$('details[aria-label="Host companion installation"]');
  await panel.waitForDisplayed({timeout:20_000});
  let firstIdentity:number[]|undefined;
  for(const [index,verb] of ['Installed host companion','Host companion'].entries()) {
    gui.stage=index===0?'published companion actual Install action':'published companion actual reuse action';
    if(!(await panel.getProperty('open')))await (await panel.$('summary')).click();
    const button=await panel.$('button');await button.waitForEnabled({timeout:10_000});
    await browser.waitUntil(async()=>(await button.getText())===(index===0?'Install companion':'Update companion'),{timeout:20_000,timeoutMsg:'Published companion action was not ready'});
    expect(await button.getText()).toBe(index===0?'Install companion':'Update companion');
    await button.click();
    let lastStage='unavailable',alertClass='unavailable',outcome='unavailable',reason='unavailable';
    try {
      await browser.waitUntil(async()=>{
        // Observe only closed values; messages, host paths and stderr stay private.
        // A completed failure exits polling before the assertion below reports it.
        try {
          const {phase,failure,state,detail}=await browser.execute(()=>{
            const element=document.querySelector('details.companion-install');
            return {phase:element?.getAttribute('data-install-phase'),failure:element?.getAttribute('data-install-failure'),state:element?.getAttribute('data-install-outcome'),detail:element?.getAttribute('data-install-reason')};
          });
          lastStage=phase==='preflight'?'preflight':companionInstallStage({stage:phase})??'unavailable';
          alertClass=failure==='none'?'none':companionInstallFailure({kind:failure}).failure;
          outcome=state && ['idle','pending','failed','uncertain','installed','reused'].includes(state)?state:'unavailable';
          reason=detail && ['committedDurabilityUnknown','commitResponseLost','verificationUnavailable','none'].includes(detail)?detail:'unavailable';
        }catch { /* A retired diagnostic observer must not replace the assertion. */ }
        if(outcome==='failed' || outcome==='uncertain')return true;
        if(outcome!==(index===0?'installed':'reused'))return false;
        const result=await panel.$('[role="status"]');
        if(!await result.isDisplayed())return false;
        const text=await result.getText();
        return text.includes(index===0?`${verb} ${evidence.version}.`:`${verb} ${evidence.version} is already installed.`);
      },{timeout:245_000,timeoutMsg:'Published companion GUI result was not observed'});
      expect(outcome,'Published companion GUI operation must be verified, not failed or uncertain').toBe(index===0?'installed':'reused');
    }catch(error) {
      console.error(`Published companion UI observation stage=${lastStage} error=${alertClass} outcome=${outcome} reason=${reason}`);
      throw error;
    }
    expect(await (await panel.$('code')).getText()).toBe(destination);
    expect(await panel.getText()).not.toContain('Some temporary installation files remain');
    const current=await installedCompanion(ssh,evidence);
    if(index===0)firstIdentity=current.identity;
    else expect(current.identity).toEqual(firstIdentity);
    expect(await gui.appOwner()).toEqual(owner);
  }
  expect(await publishedCompanion()).toEqual(evidence);
  console.info(`Published native GUI companion install/reuse verified version=${evidence.version} sha256=${evidence.sha256}; staging cleanup complete`);
  // Return through ordinary UI before the second terminal proof.
  await (await browser.$('button=Connections')).click();
  await challengeOwnedSsh(gui,ssh,terminal,owner,true);
  await disconnectOwnedSsh(gui,terminal);
});
