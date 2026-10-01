require('dotenv').config();

async function main() {
  const token = String(process.env.SPEEDSMS_ACCESS_TOKEN || '').trim();
  if (!token) throw new Error('Thiếu SPEEDSMS_ACCESS_TOKEN trong .env');

  const basic = Buffer.from(`${token}:x`, 'utf8').toString('base64');
  const response = await fetch('https://api.speedsms.vn/index.php/user/info', {
    headers: { Authorization: `Basic ${basic}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SpeedSMS HTTP ${response.status}: ${text}`);
  console.log(text);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
