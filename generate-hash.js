// generate-hash.js
const bcrypt = require('bcrypt');

async function generateHash() {
    const hash = await bcrypt.hash('admin123', 10);
    console.log('Generated hash:', hash);
    console.log('\nCopy this hash into your init.sql file:');
    console.log(`'${hash}'`);
}

generateHash();