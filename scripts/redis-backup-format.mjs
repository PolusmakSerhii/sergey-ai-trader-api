export const BACKUP_KEYS = {
  ranking: "sergey-ai:global-ranking:v1",
  history: "sergey-ai:global-ranking-history:v1",
  completedTrades: "sergey-ai:completed-trades:v1",
  completedTradeIds: "sergey-ai:completed-trade-ids:v1",
  completedTradeStats: "sergey-ai:completed-trade-stats:v1",
  openTrades: "sergey-ai:open-trades:v1"
};

export function createRestoreCommands(backup) {
  if (backup?.format !== "sergey-ai-redis-backup" ||
      ![1, 2, 3].includes(backup.version) || !backup.ranking ||
      !Array.isArray(backup.history)) {
    throw new Error("Backup file has an unsupported or invalid format");
  }
  const names = ["ranking", "history"];
  if (backup.version >= 2) names.push("completedTrades", "completedTradeIds", "completedTradeStats");
  if (backup.version >= 3) names.push("openTrades");
  for (const name of names) {
    if (backup.keys?.[name] !== BACKUP_KEYS[name]) {
      throw new Error(`Unexpected backup key: ${name}`);
    }
  }
  if (backup.version >= 2 &&
      (!Array.isArray(backup.completedTrades) ||
       !Array.isArray(backup.completedTradeIds) ||
       !backup.completedTradeIds.every(id => typeof id === "string") ||
       !(backup.completedTradeStats === null ||
         (backup.completedTradeStats && typeof backup.completedTradeStats === "object" &&
          !Array.isArray(backup.completedTradeStats))))) {
    throw new Error("Invalid completed trade backup data");
  }
  const openStatuses = new Set(["Pending", "WaitingEntry", "Active"]);
  const openTrades = backup.version >= 3 ? backup.openTrades
    : (backup.history[0]?.readySignals || []).filter(signal =>
        openStatuses.has(signal?.outcome?.status));
  if (!Array.isArray(openTrades) || !openTrades.every(signal =>
      typeof signal?.tradeId === "string" && openStatuses.has(signal?.outcome?.status))) {
    throw new Error("Invalid open trade backup data");
  }
  const commands = [
    ["SET", BACKUP_KEYS.ranking, JSON.stringify(backup.ranking)],
    ["DEL", BACKUP_KEYS.history],
    ["SET", BACKUP_KEYS.openTrades, JSON.stringify(openTrades)]
  ];
  function pushChunks(command, key, values) {
    for (let i = 0; i < values.length; i += 50) {
      commands.push([command, key, ...values.slice(i, i + 50)]);
    }
  }
  pushChunks("RPUSH", BACKUP_KEYS.history, backup.history.map(entry => JSON.stringify(entry)));
  if (backup.version >= 2) {
    commands.push(["DEL", BACKUP_KEYS.completedTrades], ["DEL", BACKUP_KEYS.completedTradeIds]);
    pushChunks("RPUSH", BACKUP_KEYS.completedTrades, backup.completedTrades.map(entry => JSON.stringify(entry)));
    pushChunks("SADD", BACKUP_KEYS.completedTradeIds, backup.completedTradeIds);
    commands.push(backup.completedTradeStats
      ? ["SET", BACKUP_KEYS.completedTradeStats, JSON.stringify(backup.completedTradeStats)]
      : ["DEL", BACKUP_KEYS.completedTradeStats]);
  }
  return commands;
}

// Commands are fully constructed and validated before Redis is contacted.
export const RESTORE_SCRIPT = `
local commands = cjson.decode(ARGV[1])
for _, command in ipairs(commands) do
  redis.call(unpack(command))
end
return #commands
`;
