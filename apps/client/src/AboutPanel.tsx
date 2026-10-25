import { useState } from "react";
import license from "../../../LICENSE?raw";
import moshIos from "../../../packages/mosh-transport/vendor/COPYING.iOS?raw";
import { api, native } from "./bridge";
import { errorMessage } from "./SessionTools";

export default function AboutPanel() {
  const [error, setError] = useState("");
  const source = `https://github.com/mihazs/lazysh${__LAZYSH_SOURCE_REVISION__ ? `/tree/${__LAZYSH_SOURCE_REVISION__}` : ""}`;
  function open(url: string) {
    if (native)
      void api.openWebUrl(url).catch((e) => setError(errorMessage(e)));
    else window.open(url, "_blank", "noopener,noreferrer");
  }
  return (
    <section className="preferences-panel" aria-label="About lazysh">
      <h2>lazysh</h2>
      <p>
        Independent SSH and AI-agent workspace. Version 0.1.0, in development.
      </p>
      <p>
        Copyright lazysh contributors. Licensed under GNU GPL version 3 or, at
        your option, any later version. Provided without warranty.
      </p>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => open(source)}>
        View corresponding source and build history
      </button>
      {__LAZYSH_SOURCE_REVISION__ && (
        <p>
          Source revision: <code>{__LAZYSH_SOURCE_REVISION__}</code>
          {__LAZYSH_SOURCE_DIRTY__
            ? " with uncommitted development changes"
            : ""}
          .
        </p>
      )}
      <p>
        For a distributed build, use its release or CI commit to identify the
        matching source. Third-party components retain their own copyright and
        license notices.
      </p>
      <details>
        <summary>GNU General Public License</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{license}</pre>
      </details>
      <details>
        <summary>Mosh notices</summary>
        <p>
          Mosh is copyright its contributors and licensed under
          GPL-3.0-or-later, with the applicable OpenSSL linking exception in its
          source headers. lazysh modifications, upstream version and checksums
          are recorded with the transport source.
        </p>
        <button onClick={() => open(source)}>Mosh source and notices</button>
        <pre style={{ whiteSpace: "pre-wrap" }}>{moshIos}</pre>
      </details>
      <p>
        ET transport includes adapted MIT-licensed code; its original notice and
        provenance accompany the source. The test font retains its Open Font
        License.
      </p>
    </section>
  );
}
