const SECRET=/authorization|cookie|token|password|secret/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IP=/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,}$/i;
export function redactSentryValue(value:unknown):unknown {
 if(typeof value==="string"){if(EMAIL.test(value))return "[email]";if(IP.test(value))return "[ip]";return value.slice(0,4000);}
 if(Array.isArray(value))return value.slice(0,50).map(redactSentryValue);
 if(value&&typeof value==="object"){const out:Record<string,unknown>={};for(const [key,item] of Object.entries(value)){if(!SECRET.test(key))out[key]=redactSentryValue(item);}return out;}
 return value;
}
