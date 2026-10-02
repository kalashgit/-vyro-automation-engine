// Stateless, signed unsubscribe links. No network or database side effects.
import {createHmac,timingSafeEqual} from "node:crypto";
const EMAIL=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export function createUnsubscribeToken(email,secret){
 if(typeof email!=="string"||!EMAIL.test(email))throw new Error("Valid email required");
 if(typeof secret!=="string"||secret.length<32)throw new Error("Strong unsubscribe secret required");
 const payload=Buffer.from(email.trim().toLowerCase()).toString("base64url");
 const signature=createHmac("sha256",secret).update(payload).digest("base64url");
 return payload+"."+signature;
}
export function verifyUnsubscribeToken(token,secret){
 if(typeof token!=="string"||typeof secret!=="string"||secret.length<32)return null;
 const parts=token.split(".");if(parts.length!==2||!parts.every(x=>/^[A-Za-z0-9_-]+$/.test(x)))return null;
 const [payload,signature]=parts;
 const expected=createHmac("sha256",secret).update(payload).digest();
 const supplied=Buffer.from(signature,"base64url");
 if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))return null;
 const email=Buffer.from(payload,"base64url").toString("utf8");
 if(!EMAIL.test(email)||email!==email.trim().toLowerCase())return null;
 return email;
}
export function buildUnsubscribeUrl(email,secret,origin){
 const url=new URL(origin);
 if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)throw new Error("Clean HTTPS origin required");
 url.pathname="/unsubscribe";url.searchParams.set("token",createUnsubscribeToken(email,secret));return url.toString();
}
