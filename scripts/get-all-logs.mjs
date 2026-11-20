const token = process.env.VERCEL_TOKEN;
const teamId = "team_XY6R90ashOH4viHCsT6oDgPL";
const deploymentId = "dpl_AxgGMDbjhj53hNdmgRptXza8vuk7";

async function main() {
  const url = `https://api.vercel.com/v2/deployments/${deploymentId}/events?teamId=${teamId}&limit=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const events = await res.json();
  for (const e of events) {
    console.log(e.created, e.type, e.text);
  }
}

main().catch(console.error);
