import {expect,test} from "bun:test";
import {redactSentryValue} from "../src/sentry-redaction";
test("expurge secrets emails IP et borne les valeurs",()=>{
 const value=redactSentryValue({authorization:"Bearer x",email:"a@b.com",ip:"192.168.1.2",nested:{cookie:"x"},long:"x".repeat(5000),items:Array.from({length:60},(_,i)=>i)}) as any;
 expect(value.authorization).toBeUndefined(); expect(value.email).toBe("[email]"); expect(value.ip).toBe("[ip]"); expect(value.nested.cookie).toBeUndefined(); expect(value.long.length).toBe(4000); expect(value.items).toHaveLength(50);
});
