package app.lazysh.client

import org.json.JSONObject

/** Closed renderer observations only; none of these fields proves transport continuity. */
internal object MoshBackgroundObservation {
    private val booleans = setOf("retained", "documentFocused", "composerPresent", "globalError", "unappliedEdit")
    private val nullable = setOf("readOnly", "disabled", "composerEmpty", "rendererConnected")
    fun expression(key: String, token: String, name: String) = """(() => {
      const retained=window[$key], terminal=retained?.terminal, pane=terminal?.closest('.terminal-pane');
      const helpers=terminal?.querySelectorAll('.xterm-helper-textarea')??[], helper=helpers.length===1?helpers[0]:null;
      const composer=pane?.querySelector('.terminal-compose textarea'), active=document.activeElement;
      const tab=document.querySelector('.session-tab-active'), dot=tab?.querySelector('.status-dot');
      return {retained:!!terminal&&retained.token===$token&&terminal.isConnected&&terminal===document.querySelector('.terminal-canvas')&&document.querySelectorAll('.terminal-canvas').length===1,
        helperCount:helpers.length===0?'zero':helpers.length===1?'one':'many',documentFocused:document.hasFocus(),
        activeKind:helper&&active===helper?'terminal':composer&&active===composer?'composer':active?.matches('button,select,input,textarea')?'control':'other',
        readOnly:helper?helper.readOnly:null,disabled:helper?helper.disabled:null,composerPresent:!!composer,
        composerEmpty:composer?composer.value.length===0:null,rendererConnected:dot&&tab.querySelector('[role=tab]')?.textContent.trim()===${JSONObject.quote(name)}?!dot.classList.contains('status-idle'):null,
        globalError:!!document.querySelector('.global-error'),unappliedEdit:!!pane?.querySelector('.terminal-edit-review')};
    })()"""

    fun parse(value: String): JSONObject {
        require(value.length <= 768)
        val sample = JSONObject(value)
        require(sample.keys().asSequence().toSet() == booleans + nullable + setOf("helperCount", "activeKind"))
        require(booleans.all { sample.get(it) is Boolean })
        require(nullable.all { sample.isNull(it) || sample.get(it) is Boolean })
        require(sample.opt("helperCount") in setOf("zero", "one", "many"))
        require(sample.opt("activeKind") in setOf("terminal", "composer", "control", "other"))
        if (sample.getString("helperCount") == "one") require(!sample.isNull("readOnly") && !sample.isNull("disabled"))
        else require(sample.isNull("readOnly") && sample.isNull("disabled"))
        require(sample.getBoolean("composerPresent") == !sample.isNull("composerEmpty"))
        return sample
    }
}
