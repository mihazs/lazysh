import {t, useUi} from './i18n/core';
import { useProtectedApi } from './access';
import { useState } from "react";
import license from "../../../LICENSE?raw";
import ptyLicense from "../../../packages/portable-pty-vendor/LICENSE.md?raw";
import opensslLicense from "../../../packages/mosh-transport/OPENSSL-LICENSE.txt?raw";
import protobufLicense from "../../../packages/mosh-transport/vendor-android/protobuf/LICENSE?raw";
import utf8License from "../../../packages/mosh-transport/vendor-android/protobuf/third_party/utf8_range/LICENSE?raw";
import abseilLicense from "../../../packages/mosh-transport/vendor-android/abseil/LICENSE?raw";
import etLicense from "../../../packages/et-transport/LICENSE-MIT?raw";
import moshIos from "../../../packages/mosh-transport/vendor/COPYING.iOS?raw";
import { api as nativeApi, native } from "./bridge";
import { errorMessage } from "./SessionTools";

export default function AboutPanel() {
  useUi();
  const api = useProtectedApi(nativeApi);
  const [error, setError] = useState("");
  const source = `https://github.com/mihazs/lazysh${__LAZYSH_SOURCE_REVISION__ ? `/tree/${__LAZYSH_SOURCE_REVISION__}` : ""}`;
  function open(url: string) {
    if (native)
      void api.openWebUrl(url).catch((e) => setError(errorMessage(e)));
    else window.open(url, "_blank", "noopener,noreferrer");
  }
  return (
    <section className="preferences-panel" aria-label={t('appAboutLazysh')}>
      <h2>lazysh</h2>
      <p>
        {t('aboutDescription', {version: '0.1.0'})}
      </p>
      <p>
        {t('aboutCopyright')}
      </p>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => open(source)}>
        {t('aboutSource')}
      </button>
      {__LAZYSH_SOURCE_REVISION__ && (
        <p>
          {t('aboutRevision')} <code>{__LAZYSH_SOURCE_REVISION__}</code>
          {__LAZYSH_SOURCE_DIRTY__
            ? ` ${t('aboutDirty')}`
            : ""}
          .
        </p>
      )}
      <p>
        {t('aboutDistributedSource')}
      </p>
      <details>
        <summary>{t('aboutLicense', {component: 'GNU General Public License'})}</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{license}</pre>
      </details>
      <details>
        <summary>{t('aboutMoshNotices')}</summary>
        <p>
          {t('aboutMoshExplanation')}
        </p>
        <button onClick={() => open(source)}>{t('aboutMoshSource')}</button>
        <pre style={{ whiteSpace: "pre-wrap" }}>{moshIos}</pre>
      </details>
      {[
        ["Protocol Buffers", protobufLicense],
        ["UTF-8 Range", utf8License],
        ["Abseil", abseilLicense],
        ["OpenSSL", opensslLicense],
        ["Eternal Terminal adapter", etLicense],
        ["Portable PTY", ptyLicense],
      ].map(([name, text]) => (
        <details key={name}>
          <summary>{t('aboutLicense', {component: name})}</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{text}</pre>
        </details>
      ))}
    </section>
  );
}
