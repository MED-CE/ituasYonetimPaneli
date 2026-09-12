import os

project_dir = r"C:\Users\eminm\Desktop\code 22 - 11.09.26\code 22 - 11.09.26\istanbulls-6064-yonetim paneli"
extensions = {'.js', '.jsx', '.html', '.json', '.css', '.md'}

replacements = [
    ('istanbulls-logo.png', 'ituas-logo.jpg'),
    ('Istanbulls 6064', 'İTÜAS Otonom Tekne Takımı'),
    ('ISTANBULLS 6064', 'İTÜAS OTONOM TEKNE TAKIMI'),
    ('Istanbulls', 'İTÜAS'),
    ('ISTANBULLS', 'İTÜAS'),
    ('istanbulls-6064', 'ituas-otonom'),
    ('istanbulls6064', 'ituasotonom'),
    ('istanbulls', 'ituas')
]

css_replacements = [
    ('#ff9d22', '#00b4d8'),
    ('#d86d06', '#0077b6'),
    ('#f07b08', '#0096c7'),
    ('#c96505', '#0077b6'),
    ('#984800', '#03045e'),
    ('#ff8a0b', '#00b4d8'),
    ('#ff9b1c', '#00b4d8'),
    ('#e88312', '#0096c7'),
    ('#ffad47', '#48cae4'),
    ('#ff941d', '#00b4d8'),
    ('#ff981e', '#00b4d8'),
    ('#ff8b00', '#00b4d8'),
    ('#e27a0c', '#0077b6')
]

for root, dirs, files in os.walk(project_dir):
    dirs[:] = [d for d in dirs if d not in ('node_modules', '.git', 'dist')]
    for file in files:
        ext = os.path.splitext(file)[1]
        if ext in extensions or file == '.env':
            filepath = os.path.join(root, file)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
            except UnicodeDecodeError:
                continue
                
            new_content = content
            for old, new in replacements:
                new_content = new_content.replace(old, new)
                
            if ext == '.css':
                for old, new in css_replacements:
                    new_content = new_content.replace(old, new)
                    
            if content != new_content:
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                print(f"Updated: {filepath}")

print("Done!")

