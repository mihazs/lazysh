package app.lazysh.client

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Test APK only: observe the original document without changing input or capture. */
internal class OwnedDpadDomObservation(nonce: String, private val evaluate: (String, Long) -> String) {
    init { require(Regex("[0-9a-f]{32}").matches(nonce)) }
    private val key="__lazyshOwnedDpadDom_$nonce"
    private val owner=UUID.randomUUID().toString()
    private var attempted=false
    private fun script(source: String) = source.replace("@@KEY@@",JSONObject.quote(key)).replace("@@OWNER@@",JSONObject.quote(owner))
    fun install(remainingMillis: Long) {
        require(remainingMillis>0);attempted=true
        check(evaluate(script(INSTALL),remainingMillis.coerceAtMost(1_000))=="true") { "Owned D-pad DOM observation unavailable" }
    }
    fun failureSummary(): String = try {
        val source=JSONObject(evaluate(script(READ),1_000))
        require(source.get("state")=="observed" && source.get("schemaVersion")==1)
        val output=JSONObject().put("schemaVersion",1).put("state","observed")
        for(name in listOf("overflow","admitted","connected")) { val flag=source.get(name);require(flag is Boolean);output.put(name,flag) }
        val rows=source.getJSONArray("events");require(rows.length()<=32);val result=JSONArray()
        for(index in 0 until rows.length()) {
            val sourceRow=rows.getJSONObject(index);val row=JSONObject()
            for((name,allowed) in listOf(
                "kind" to listOf("pointerdown","pointermove","pointerup","pointercancel","gotpointercapture","lostpointercapture","outline"),
                "target" to listOf("pad","arrow","other"),"capture" to listOf("yes","no","unavailable"),
                "displacement" to listOf("up","left","down","right","neutral","other","unavailable"),
                "outline" to listOf("up","left","down","right","none","multiple","unavailable"))) {
                val value=sourceRow.get(name);require(value in allowed);row.put(name,value)
            }
            for(name in listOf("trusted","samePointer","primary","touch","pressed","connected")) {
                val value=sourceRow.get(name);require(value is Boolean);row.put(name,value)
            }
            val time=sourceRow.get("atMs");require(time is Int || time is Long)
            require((time as Number).toLong() in 0..65_535);row.put("atMs",time);result.put(row)
        }
        output.put("events",result).toString()
    } catch (_: Throwable) { "{\"state\":\"unavailable\"}" }
    fun close() {
        if(!attempted)return
        val removed=runCatching { evaluate(script(CLEANUP),1_000)=="true" }.getOrDefault(false)
        check(removed) { "Owned D-pad DOM observation cleanup unavailable" };attempted=false
    }
    companion object {
        private val INSTALL = """
            (()=>{const key=@@KEY@@,owner=@@OWNER@@;
              if(Object.hasOwn(window,key))return false;
              const pads=document.querySelectorAll('.terminal-dpad');if(pads.length!==1)return false;
              const pad=pads[0],types=['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'];
              const events=[],added=[];let observer=null,tracked=null,x=0,y=0,started=0,active=true,overflow=false,lastOutline=null;
              const connected=()=>pad.isConnected===true;
              const outline=()=>{if(!connected())return 'unavailable';
                const arrows=Array.from(pad.querySelectorAll('button[data-dpad-direction]'));
                if(arrows.length!==4||new Set(arrows.map(a=>a.dataset.dpadDirection)).size!==4||arrows.some(a=>!['up','left','down','right'].includes(a.dataset.dpadDirection)))return 'unavailable';
                const selected=arrows.filter(a=>Boolean(a.style.outline));return selected.length===0?'none':selected.length===1?selected[0].dataset.dpadDirection:'multiple';};
              const capture=()=>{try{return tracked===null||typeof pad.hasPointerCapture!=='function'?'unavailable':pad.hasPointerCapture(tracked)?'yes':'no';}catch{return 'unavailable';}};
              const append=row=>{if(events.length<32)events.push(row);else overflow=true;};
              const record=(kind,event)=>{const same=Boolean(event&&event.pointerId===tracked),target=event?.target;
                const dx=same?event.clientX-x:NaN,dy=same?event.clientY-y:NaN;
                const displacement=!same?'other':!Number.isFinite(dx)||!Number.isFinite(dy)?'unavailable':Math.max(Math.abs(dx),Math.abs(dy))<12?'neutral':Math.abs(dx)>Math.abs(dy)?dx>0?'right':'left':dy>0?'down':'up';
                append({kind,atMs:Math.max(0,Math.min(65535,Math.trunc(performance.now()-started))),
                  trusted:event?.isTrusted===true,samePointer:same,primary:event?.isPrimary===true,touch:event?.pointerType==='touch',pressed:Boolean(event&&(event.buttons&1)),
                  target:!event||target===pad?'pad':pad.contains(target)&&target.closest?.('button[data-dpad-direction]')?'arrow':'other',
                  capture:capture(),displacement,outline:outline(),connected:connected()});};
              const onPointer=event=>{if(!active)return;
                if(tracked===null){if(event.type!=='pointerdown'||event.isTrusted!==true||event.isPrimary!==true||event.button!==0||
                  !pad.contains(event.target)||!event.target.closest?.('button[data-dpad-direction]')||!Number.isInteger(event.pointerId)||
                  !Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return;
                  tracked=event.pointerId;x=event.clientX;y=event.clientY;started=performance.now();}
                if(!pad.contains(event.target)&&event.pointerId!==tracked)return;
                record(event.type,event);};
              const cleanup=()=>{active=false;for(const type of added)document.removeEventListener(type,onPointer,true);observer?.disconnect();};
              try {for(const type of types){document.addEventListener(type,onPointer,{capture:true,passive:true});added.push(type);}
                observer=new MutationObserver(()=>{if(!active||tracked===null)return;const current=outline();if(current!==lastOutline){lastOutline=current;record('outline',null);}});
                observer.observe(pad,{attributes:true,attributeFilter:['style'],childList:true,subtree:true});
                window[key]={owner,read:()=>({schemaVersion:1,state:'observed',overflow,admitted:tracked!==null,connected:connected(),events:events.map(row=>({...row}))}),cleanup};return true;
              }catch{cleanup();return false;}})()
        """.trimIndent()
        private val READ = """
            (()=>{const entry=window[@@KEY@@];return entry?.owner===@@OWNER@@?entry.read():{state:'unavailable'};})()
        """.trimIndent()
        private val CLEANUP = """
            (()=>{const key=@@KEY@@,entry=window[key];if(entry===undefined)return true;if(entry.owner!==@@OWNER@@)return false;
              entry.cleanup();if(window[key]===entry)delete window[key];return true;})()
        """.trimIndent()
    }
}
