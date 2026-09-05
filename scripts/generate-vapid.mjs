import webpush from 'web-push';
const keys = webpush.generateVAPIDKeys();
console.log('\nWyNotify Web Push keys\n');
console.log(`WEB_PUSH_PUBLIC_KEY=${keys.publicKey}`);
console.log(`WEB_PUSH_PRIVATE_KEY=${keys.privateKey}`);
console.log('WEB_PUSH_SUBJECT=mailto:notifications@YOUR-DOMAIN.com');
console.log('\nKeep WEB_PUSH_PRIVATE_KEY secret. Use the public key in browsers only.\n');
