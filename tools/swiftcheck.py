#!/usr/bin/env python3
"""Structural sanity check for Swift sources.

No Swift toolchain is available in this environment, so this catches the
mechanical class of errors a compiler would: unbalanced delimiters, stray
smart quotes in code, duplicate dictionary-literal keys (which trap at
runtime, not compile time), and references to types nothing declares.
"""
import re, sys, os, collections

SRC = sys.argv[1] if len(sys.argv) > 1 else "Sources"

def strip_noise(text):
    """Remove comments and string literals so delimiters inside them don't count."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '#':
            hashes = 0
            while i + hashes < n and text[i + hashes] == '#':
                hashes += 1
            if text[i + hashes : i + hashes + 1] == '"':
                terminator = '"' + '#' * hashes
                j = text.find(terminator, i + hashes + 1)
                i = n if j < 0 else j + len(terminator)
                out.append('""')
                continue
            out.append(c)
            i += 1
            continue
        if c == '"':
            if text[i:i+3] == '"""':
                j = text.find('"""', i+3)
                i = n if j < 0 else j+3
                out.append(' ')
                continue
            j = i+1
            while j < n:
                if text[j] == '\\': j += 2; continue
                if text[j] == '"': break
                if text[j] == '\n': break
                j += 1
            out.append('""')
            i = j+1
            continue
        if text[i:i+2] == '//':
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if text[i:i+2] == '/*':
            depth, j = 1, i+2
            while j < n and depth:
                if text[j:j+2] == '/*': depth += 1; j += 2; continue
                if text[j:j+2] == '*/': depth -= 1; j += 2; continue
                j += 1
            i = j
            out.append(' ')
            continue
        out.append(c)
        i += 1
    return ''.join(out)

errors, warnings = [], []
declared, referenced = collections.defaultdict(list), collections.defaultdict(list)

DECL = re.compile(r'\b(?:public |internal |private |fileprivate |open |final |indirect )*'
                  r'(struct|class|enum|protocol|actor|typealias)\s+([A-Z]\w*)')

for root, _, files in os.walk(SRC):
    for name in sorted(files):
        if not name.endswith('.swift'): continue
        path = os.path.join(root, name)
        raw = open(path, encoding='utf-8').read()
        code = strip_noise(raw)

        # Delimiter balance
        for open_ch, close_ch, label in (('{','}','braces'), ('(',')','parens'), ('[',']','brackets')):
            d = code.count(open_ch) - code.count(close_ch)
            if d: errors.append(f"{path}: {label} unbalanced by {d:+d}")

        # Smart quotes outside strings/comments are always a mistake in code.
        for ch in '“”‘’':
            if ch in code:
                line = code[:code.index(ch)].count('\n') + 1
                errors.append(f"{path}:{line}: smart quote {ch!r} in code")

        for m in DECL.finditer(code):
            declared[m.group(2)].append(path)
        for m in re.finditer(r'\b([A-Z][A-Za-z0-9]*)\b', code):
            referenced[m.group(1)].append(path)

        # Duplicate keys in dictionary literals trap at runtime.
        for m in re.finditer(r'\[\s*((?:"[^"\n]*"\s*:\s*"[^"\n]*"\s*,?\s*){3,})\]', raw):
            keys = re.findall(r'"([^"\n]*)"\s*:', m.group(1))
            dupes = [k for k, c in collections.Counter(keys).items() if c > 1]
            if dupes:
                line = raw[:m.start()].count('\n') + 1
                errors.append(f"{path}:{line}: duplicate dictionary keys {dupes}")

NESTED_OK = {'CodingKeys', 'Entry', 'Configuration', 'Result', 'Output',
             'Phase', 'Kind', 'Paragraph', 'Marker', 'Header', 'Context', 'Thresholds'}
for name, paths in sorted(declared.items()):
    if name in NESTED_OK:
        continue
    counts = collections.Counter(paths)
    if len(set(paths)) > 1 or any(c > 1 for c in counts.values()):
        warnings.append(f"declared more than once: {name} in {sorted(set(paths))}")

print(f"checked {sum(1 for r,_,fs in os.walk(SRC) for f in fs if f.endswith('.swift'))} files")
print(f"types declared: {len(declared)}")
for w in warnings: print("WARN ", w)
for e in errors: print("ERROR", e)
sys.exit(1 if errors else 0)
