"""Build the English-default site and dependency-free single-file preview."""
from pathlib import Path
from html.parser import HTMLParser
import html
import json
import base64
import re

ROOT = Path(__file__).resolve().parent
LANGUAGES = ('zh', 'en', 'es', 'fr', 'ko', 'ja')
catalog = {}
for number, line in enumerate((ROOT / 'translations.tsv').read_text(encoding='utf-8').splitlines(), 1):
    if not line.strip():
        continue
    values = line.split('|')
    if len(values) != 6:
        raise ValueError(f'Line {number}: expected six translations')
    catalog[values[0]] = dict(zip(LANGUAGES, values))
catalog['。'] = dict(zip(LANGUAGES, ('。', '.', '.', '.', '.', '。')))
(ROOT / 'locales.js').write_text('window.RESPIRE_TRANSLATIONS = ' + json.dumps(catalog, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')

class EnglishPage(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.parts = []
    def handle_decl(self, decl):
        self.parts.append('<!' + decl + '>')
    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        translated = []
        for name, value in attrs:
            if value is not None and name in ('aria-label', 'title', 'alt'):
                value = catalog.get(value, {}).get('en', value)
            if tag == 'html' and name == 'lang':
                value = 'en'
            if tag == 'meta' and values.get('name') == 'description' and name == 'content':
                value = catalog['respire 是独立于 Agent 的个人记忆层。']['en']
            if tag == 'iframe' and name == 'src':
                value = 'preview/client.en.html'
            translated.append(name if value is None else name + '="' + html.escape(value, quote=True) + '"')
        self.parts.append('<' + tag + (' ' + ' '.join(translated) if translated else '') + '>')
    def handle_endtag(self, tag):
        self.parts.append('</' + tag + '>')
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.parts[-1] = self.parts[-1][:-1] + '/>'
    def handle_data(self, text):
        key = text.strip()
        if key in catalog:
            text = re.match(r'^\s*', text)[0] + catalog[key]['en'] + re.search(r'\s*$', text)[0]
        self.parts.append(html.escape(text, quote=False))
    def handle_entityref(self, name):
        self.parts.append('&' + name + ';')
    def handle_charref(self, name):
        self.parts.append('&#' + name + ';')
    def handle_comment(self, data):
        self.parts.append('<!--' + data + '-->')

page = EnglishPage()
page.feed((ROOT / 'index.template.html').read_text(encoding='utf-8'))
document = ''.join(page.parts)
(ROOT / 'index.html').write_text(document, encoding='utf-8')

standalone = document
for file in ('styles.css',):
    standalone = standalone.replace(f'<link rel="stylesheet" href="{file}">', '<style>\n' + (ROOT / file).read_text(encoding='utf-8') + '\n</style>')
for file in ('assets/logo.svg', 'assets/mark.svg'):
    data = 'data:image/svg+xml;base64,' + base64.b64encode((ROOT / file).read_bytes()).decode('ascii')
    standalone = standalone.replace(f'src="{file}"', f'src="{data}"').replace(f'href="{file}"', f'href="{data}"')
previews = {lang: (ROOT / f'preview/client.{lang}.html').read_text(encoding='utf-8') for lang in ('en', 'zh')}
embedded = '<script>window.RESPIRE_EMBEDDED_PREVIEWS=' + json.dumps(previews, ensure_ascii=False).replace('</', '<\\/') + ';</script>\n'
standalone = standalone.replace('src="preview/client.en.html"', 'data-embedded-preview="true"')
standalone = standalone.replace('<script src="main.js"></script>', embedded + '<script src="main.js"></script>')
for file in ('config.js', 'locales.js', 'prompts.js', 'i18n.js', 'main.js', 'motion.js'):
    script = (ROOT / file).read_text(encoding='utf-8').replace('</script', '<\\/script')
    standalone = standalone.replace(f'<script src="{file}"></script>', '<script>\n' + script + '\n</script>')
(ROOT / 'standalone.html').write_text(standalone, encoding='utf-8')
print(f'Built English default, {len(catalog)} translation keys, six languages, two preserved client previews.')
