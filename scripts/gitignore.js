const fs = require('fs');
const p = '/home/dante/Project/VRouter/.gitignore';
fs.writeFileSync(
  p,
  ['node_modules/', 'data/', '.env', '*.log'].join('\n') + '\n'
);
console.log('.gitignore yazıldı');
