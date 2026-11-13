import {expect} from '@wdio/globals';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import DocumentPicker from '../../../pageobjects/components/document-picker.component';
import HostPathSheet from '../../../pageobjects/components/host-path-sheet.component';
import Toolbar from '../../../pageobjects/components/toolbar.component';
import Terminal from '../../../pageobjects/terminal.page';
import Files from '../../../pageobjects/components/files.component';
import {resetApp} from '../../../support/app';
import {findDeviceFiles, readDeviceFile, removeDeviceFiles} from '../../../support/deviceFiles';
import {readEndpoint, runNonce} from '../../../support/hosts';

describe('#1240 and #1242 Files and the terminal open host paths', () => {
  const nonce = runNonce(), folder = `e2e-${nonce}-files`, file = `hello-${nonce}.txt`, content = `hello from the host ${nonce}\n`;
  let home: string, name: string;
  before(async () => {
    home = (await readEndpoint('sftp')).home;
    await mkdir(join(home, folder));
    await writeFile(join(home, folder, file), content);
    name = await connectOwnedHost({kind: 'sftp'});
  });
  after(async () => { await removeDeviceFiles(file); await rm(join(home, folder), {recursive: true, force: true}); await resetApp(); });

  it('opens a path printed in the terminal in a sheet that resolves ~ against the host home', async () => {
    // The path is built by the shell from two arguments, so the command line the terminal echoes does not hold it: only the output does.
    const shown = `~/${folder}/${file}`;
    await Terminal.type(name, `printf 'see %s%s\\n' '~/' '${folder}/${file}'`);
    await Toolbar.press('enter');
    await Terminal.in(() => expect(Terminal.screen(name)).toHaveText(expect.stringContaining(`see ${shown}`)));
    await HostPathSheet.openByTapping(shown);
    await HostPathSheet.in(() => expect(HostPathSheet.root).toHaveText(expect.stringContaining(`${home}/${folder}/${file}`)));
    await HostPathSheet.close();
  });

  describe('Files', () => {
    before(async () => { await Files.show(); });

    it('opens ~ in the home of the host and shows the resolved absolute path', async () => {
      await Files.goTo('~');
      await Files.in(() => expect(Files.directory).toHaveValue(home));
    });

    it('opens a folder under ~/ and lists its files', async () => {
      await Files.goTo(`~/${folder}`);
      await Files.in(async () => {
        await expect(Files.directory).toHaveValue(`${home}/${folder}`);
        await expect(Files.entry(file)).toBeDisplayed();
      });
    });

    it("refuses another user's home and says only ~ and ~/ expand", async () => {
      await Files.goTo('~root/.ssh');
      await Files.in(() => expect(Files.alert).toHaveText(expect.stringContaining('Only ~ and ~/ expand')));
    });

    it('downloads a small file through the system document picker and the bytes arrive on the device', async () => {
      await Files.goTo(`~/${folder}`);
      await Files.choose(file);
      await Files.startDownload();
      await DocumentPicker.in(() => expect(DocumentPicker.fileName).toHaveText(file));
      await DocumentPicker.saveHere();
      await Files.in(() => expect(Files.saved).toBeDisplayed());
      const saved = await findDeviceFiles(file);
      expect(saved).toHaveLength(1);
      expect(await readDeviceFile(saved[0])).toBe(content);
    });

  });
});
