/** Synthetic device identity and frame bytes; no SDK or device is contacted. */
export const deviceFrame={schemaVersion:1,platform:'android',id:'emulator-5554',mime:'image/jpeg',base64:'/9j/2Q==',width:1080,height:1920,imageWidth:540,imageHeight:960};
export const deviceRecord={id:deviceFrame.id,name:'Emulator {{raw}}',state:'running',kind:'emulator',capabilities:{screenshot:true,tap:true,swipe:true,key:true,boot:true,reboot:true,shutdown:true}};
export const deviceInventory={schemaVersion:1,devices:[deviceRecord],avds:[{id:'raw-avd',name:'AVD {{raw}}'}],warnings:['Native SDK warning {{raw}} <path>']};
export const androidVideoProbe={schemaVersion:1,id:deviceFrame.id,platform:'android',stream:true,viewOnly:true,maximumSeconds:180};
export const iosDeviceRecord={...deviceRecord,id:'ios-id',name:'iPhone {{raw}}',capabilities:{screenshot:true,tap:false,key:false}};
export const iosDeviceProbe={schemaVersion:1,id:iosDeviceRecord.id,platform:'ios',width:390,height:844};
