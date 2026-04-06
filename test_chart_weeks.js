const { fetchWeeklyData } = require('./generate_chart');
async function main() {
  const data = await fetchWeeklyData('act_160907410994298', '2026-03-30', '2026-04-05');
  console.log('Total weeks:', data.length);
  data.forEach((w,i) => console.log('  Week', i+1, ':', w.weekStart, 'days:', w.days, 'label:', w.label, 'sublabel:', w.sublabel, 'partial:', w.isPartial, 'spend:', w.spend.toFixed(2)));
}
main().catch(e => console.error(e));
