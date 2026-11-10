// Deliberately inert default. Activation requires a separately reviewed composition.
// Configuration names: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
// QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY. No environment values read here.
export const config={api:{bodyParser:false}};
export const DESTINATION='https://sergey-ai-trader-api.vercel.app/api/ready-trade-notifications';
export const SIGNED_BODY='{}';
export function createHandler({enabled=false,receiverClass,signingKeys,run}={}){
 return async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');
 const reply=(code,status)=>res.status(code).json({status});
 if(!enabled)return reply(503,'DISABLED');
 if(req.method!=='POST')return reply(405,'METHOD_REJECTED');
 if(req.url!=='/api/ready-trade-notifications')return reply(403,'DESTINATION_REJECTED');
 try{
 const signature=req.headers?.['upstash-signature'];
 if(typeof signature!=='string'||signature.length>8192||!signingKeys?.QSTASH_CURRENT_SIGNING_KEY||!signingKeys?.QSTASH_NEXT_SIGNING_KEY)return reply(401,'AUTH_REJECTED');
 // Fixed body only; no caller-selected keys, candidates or destination.
 let raw='';for await(const chunk of req){raw+=Buffer.from(chunk).toString('utf8');if(raw.length>2)return reply(400,'BODY_REJECTED');}
 if(raw!==SIGNED_BODY)return reply(400,'BODY_REJECTED');
 const Receiver=await receiverClass();
 const verified=await new Receiver({currentSigningKey:signingKeys.QSTASH_CURRENT_SIGNING_KEY,nextSigningKey:signingKeys.QSTASH_NEXT_SIGNING_KEY}).verify({signature,body:SIGNED_BODY,url:DESTINATION});
 if(verified!==true)return reply(401,'AUTH_REJECTED');
 }catch{return reply(401,'AUTH_REJECTED');}
 try{const result=await run();const allowed=['BASELINED','BASELINE_RACE','COMPLETE','UNAVAILABLE','BUDGET_EXHAUSTED'];return reply(result?.status==='COMPLETE'||result?.status==='BASELINED'?200:503,allowed.includes(result?.status)?result.status:'UNAVAILABLE');}
 catch{return reply(503,'UNAVAILABLE');}
 };
}
export default createHandler();
