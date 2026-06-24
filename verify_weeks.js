const { fetchWeeklyData } = require('./generate_chart.js');

(async () => {
  const data = await fetchWeeklyData("act_747429766205314", "2026-04-05", "2026-04-11");
  data.forEach((w, i) => {
    console.log("Week " + (i+1) + ": " + w.weekStart + " | days: " + w.days + " | spend: $" + w.spend.toFixed(2) + " | leads: " + w.leads);
  });
  // Specifically check last 3 weeks
  const last3 = data.slice(-3);
  console.log("\nLast 3 weeks detail:");
  last3.forEach((w, i) => {
    console.log("  " + w.label + " (" + w.sublabel + "): " + w.days + " days, $" + w.spend.toFixed(2) + " spend, " + w.leads + " leads");
  });
})();