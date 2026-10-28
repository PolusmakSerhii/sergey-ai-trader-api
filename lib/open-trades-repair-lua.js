// Standard SHA-256 over Redis bytes. Redis exposes SHA-1 only; SHA-256 is required by
// frozen incident evidence. Tested against node:crypto vectors on real local Redis.
export const LUA_SHA256 = `
local function sha256(message)
  local band, bxor, bnot, rshift, ror, tobit = bit.band, bit.bxor, bit.bnot, bit.rshift, bit.ror, bit.tobit
  local K = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 }
  local H = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19}
  local n = #message
  local function word(x) return string.char(band(rshift(x,24),255),band(rshift(x,16),255),band(rshift(x,8),255),band(x,255)) end
  message = message .. string.char(128) .. string.rep(string.char(0),(55-n)%64) .. word(math.floor(n/536870912)) .. word((n*8)%4294967296)
  for offset = 1,#message,64 do
    local W = {}
    for i=1,16 do local j=offset+(i-1)*4; local a,b,c,d=string.byte(message,j,j+3);W[i]=tobit(a*16777216+b*65536+c*256+d) end
    for i=17,64 do
      local x,y=W[i-15],W[i-2]
      local s0=bxor(ror(x,7),ror(x,18),rshift(x,3));local s1=bxor(ror(y,17),ror(y,19),rshift(y,10))
      W[i]=tobit(W[i-16]+s0+W[i-7]+s1)
    end
    local a,b,c,d,e,f,g,h=unpack(H)
    for i=1,64 do
      local S1=bxor(ror(e,6),ror(e,11),ror(e,25));local ch=bxor(band(e,f),band(bnot(e),g))
      local t1=tobit(h+S1+ch+K[i]+W[i]);local S0=bxor(ror(a,2),ror(a,13),ror(a,22));local maj=bxor(band(a,b),band(a,c),band(b,c))
      local t2=tobit(S0+maj);h=g;g=f;f=e;e=tobit(d+t1);d=c;c=b;b=a;a=tobit(t1+t2)
    end
    local values={a,b,c,d,e,f,g,h};for i=1,8 do H[i]=tobit(H[i]+values[i]) end
  end
  local result={};for i=1,8 do local x=H[i];if x<0 then x=x+4294967296 end;result[i]=string.format('%08x',x) end
  return table.concat(result)
end
`;
// Server code supplies frozen constants, never request data. The live endpoint has no
// generic EVAL/rollback mode. Both keys are checked inside the script as well.
export function buildIncidentScript({key,backupKey,incident,guard}) {
  return LUA_SHA256 + guard + `
local function equal(a,b)
  if type(a)~=type(b) then return false end
  if type(a)~='table' then return a==b end
  for k,v in pairs(a) do if not equal(v,b[k]) then return false end end
  for k,_ in pairs(b) do if a[k]==nil then return false end end
  return true
end
local function arrayStarts(raw)
  local starts={};local i=1
  while string.match(string.sub(raw,i,i),'%s') do i=i+1 end
  if string.sub(raw,i,i)~='[' then return nil end
  i=i+1
  while i<=#raw do
    while string.match(string.sub(raw,i,i),'%s') do i=i+1 end
    if string.sub(raw,i,i)==']' then return starts end
    starts[#starts+1]=i
    local depth,quoted,escaped=0,false,false
    while i<=#raw do
      local ch=string.sub(raw,i,i)
      if quoted then
        if escaped then escaped=false elseif string.byte(ch)==92 then escaped=true elseif ch=='"' then quoted=false end
      elseif ch=='"' then quoted=true
      elseif (ch==',' or ch==']') and depth==0 then break
      elseif ch=='{' or ch=='[' then depth=depth+1
      elseif ch=='}' or ch==']' then depth=depth-1 end
      i=i+1
    end
    if string.sub(raw,i,i)==']' then return starts end
    if string.sub(raw,i,i)~=',' then return nil end
    i=i+1
  end
  return nil
end
if #KEYS~=2 or #ARGV~=2 or KEYS[1]~=${JSON.stringify(key)} or KEYS[2]~=${JSON.stringify(backupKey)} then return -2 end
local current=redis.call('GET',KEYS[1])
if not current or current~=ARGV[1] then return 0 end
if #ARGV[1]~=${incident.originalBytes} or sha256(ARGV[1])~=${JSON.stringify(incident.originalSha)} then return -2 end
local okOriginal,original=pcall(cjson.decode,ARGV[1]);local okCandidate,candidate=pcall(cjson.decode,ARGV[2])
if not okOriginal or not okCandidate or type(original)~='table' or original==cjson.null or #original~=${incident.originalCount} then return -2 end
if not string.match(ARGV[1],'^%s*%[') or not string.match(ARGV[2],'^%s*%[') or not validTrades(candidate,true) or #candidate~=${incident.candidateCount} then return -2 end
local originalCount=0;for index,_ in pairs(original) do if type(index)~='number' or index<1 or index%1~=0 then return -2 end;originalCount=originalCount+1 end
if originalCount~=${incident.originalCount} or validTrades(original,true) then return -2 end
if not equal(original[${incident.keepIndex+1}],original[${incident.removeIndex+1}]) then return -2 end
local ids,setups={},{};local duplicateIds,duplicateSetups=0,0
for i,row in ipairs(original) do
  if not validTrades({row},true) then return -2 end
  if ids[row.tradeId] then if ids[row.tradeId]~=${incident.keepIndex+1} or i~=${incident.removeIndex+1} then return -2 end;duplicateIds=duplicateIds+1 else ids[row.tradeId]=i end
  if setups[row.setupKey] then if setups[row.setupKey]~=${incident.keepIndex+1} or i~=${incident.removeIndex+1} then return -2 end;duplicateSetups=duplicateSetups+1 else setups[row.setupKey]=i end
end
if duplicateIds~=1 or duplicateSetups~=1 then return -2 end
local starts=arrayStarts(ARGV[1]);if not starts or #starts~=${incident.originalCount} then return -2 end
local exactCandidate=string.sub(ARGV[1],1,starts[${incident.removeIndex+1}]-1)..string.sub(ARGV[1],starts[${incident.removeIndex+2}])
if ARGV[2]~=exactCandidate then return -2 end
for i,row in ipairs(candidate) do local oldIndex=i;if i>${incident.removeIndex} then oldIndex=i+1 end;if not equal(row,original[oldIndex]) then return -2 end end
if redis.call('EXISTS',KEYS[2])~=0 then return -1 end
-- No writes above this line. Redis Lua prevents interleaving, NOT rollback on errors.
local saved=redis.call('SET',KEYS[2],ARGV[1],'NX')
if not saved then return -3 end
if redis.call('GET',KEYS[2])~=ARGV[1] then return -4 end
-- A backup-created / target-unchanged outcome is safe and consumes the incident.
redis.call('SET',KEYS[1],ARGV[2])
return 1
`;
}
