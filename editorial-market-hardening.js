import fs from 'node:fs/promises';

async function applyAutomationMarketRouting(relativePath, label) {
  const automationPath = new URL(relativePath, import.meta.url);
  let automation = await fs.readFile(automationPath, 'utf8');

  if (!automation.includes("market: index === 1 ? 'random' : 'argentina'")) {
    const target = '      category: rotation[index % rotation.length],';
    if (!automation.includes(target)) throw new Error(`editorial_market_slot_target_not_found:${label}`);
    automation = automation.replace(target, `${target}\n      market: index === 1 ? 'random' : 'argentina',`);
  }

  if (!automation.includes('          market: slot.market,')) {
    const target = '          category: clean(saved.category) || slot.category,';
    if (!automation.includes(target)) throw new Error(`editorial_market_merge_target_not_found:${label}`);
    automation = automation.replace(target, `${target}\n          market: slot.market,`);
  }

  if (!automation.includes('        market: next.market,')) {
    const target = '      payload: {\n        category: next.category,';
    if (!automation.includes(target)) throw new Error(`editorial_market_payload_target_not_found:${label}`);
    automation = automation.replace(target, `${target}\n        market: next.market,`);
  }

  await fs.writeFile(automationPath, automation, 'utf8');
}

await applyAutomationMarketRouting('./buffer-automation.js', 'buffer');
await applyAutomationMarketRouting('./metricool-automation.js', 'metricool');

const runnerPath = new URL('./job-runner.js', import.meta.url);
let runner = await fs.readFile(runnerPath, 'utf8');

if (!runner.includes("const market = String(payload.market || 'random').toLowerCase();")) {
  const target = "  const category = String(payload.category || 'actualidad');";
  if (!runner.includes(target)) throw new Error('editorial_market_runner_target_not_found');
  runner = runner.replace(target, `${target}\n  const market = String(payload.market || 'random').toLowerCase();`);
}

if (!runner.includes("studioCall('/api/engine/topic', { category, market, ...context }")) {
  const target = "  return studioCall('/api/engine/topic', { category, ...context }, { timeoutMs: 180000, attempts: 5 });";
  if (!runner.includes(target)) throw new Error('editorial_market_topic_call_target_not_found');
  runner = runner.replace(target, "  return studioCall('/api/engine/topic', { category, market, ...context }, { timeoutMs: 180000, attempts: 5 });");
}

await fs.writeFile(runnerPath, runner, 'utf8');
console.log('[como-asi] editorial market routing applied (Metricool+Buffer: 08:00/20:30 Argentina, 13:00 random)');
