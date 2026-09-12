import fs from 'fs';
import path from 'path';

const projectDir = 'C:/Users/eminm/Desktop/code 22 - 11.09.26/code 22 - 11.09.26/istanbulls-6064-yonetim paneli';

const replacements = [
  { from: /istanbulls-logo\.png/g, to: 'ituas-logo.jpg' },
  { from: /Istanbulls 6064/g, to: 'İTÜAS Otonom Tekne Takımı' },
  { from: /ISTANBULLS 6064/g, to: 'İTÜAS OTONOM TEKNE TAKIMI' },
  { from: /Istanbulls/g, to: 'İTÜAS' },
  { from: /ISTANBULLS/g, to: 'İTÜAS' },
  { from: /istanbulls-6064/g, to: 'ituas-otonom' },
  { from: /istanbulls6064/g, to: 'ituasotonom' },
  { from: /istanbulls/g, to: 'ituas' }
];

const extensions = ['.js', '.jsx', '.html', '.json', '.css', '.md'];

function processDirectory(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
    
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      processDirectory(fullPath);
    } else {
      const ext = path.extname(file);
      if (extensions.includes(ext) || file === '.env') {
        let content = fs.readFileSync(fullPath, 'utf8');
        let newContent = content;
        for (const { from, to } of replacements) {
          newContent = newContent.replace(from, to);
        }
        if (content !== newContent) {
          fs.writeFileSync(fullPath, newContent, 'utf8');
          console.log(`Updated: ${fullPath}`);
        }
      }
    }
  }
}

processDirectory(projectDir);
console.log('Done!');

