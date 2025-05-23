fetch('https://discord.com/api/webhooks/1375557655036301593/fAVFnmHle5XCW4nxYD3GKHetyJRbGyQa6IXia2LbrEmk4Sn6Gaym_YduQpvpgkD2h0oA', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: "Webhook test from browser console" }),
})
.then(() => console.log("Webhook test sent"))
.catch(e => console.error("Webhook test failed:", e));
