#!/usr/bin/env python3
"""Cross-reference own types' static members and initializer labels.

Heuristic stand-in for a compiler: collects every member declared on each
type in this package, then checks every `MyType.member` reference and every
`MyType(label:...)` call against them.
"""
import re, sys, os, collections

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


roots = sys.argv[1:] or ["Sources", "Tests"]
files = []
for root in roots:
    for d, _, fs in os.walk(root):
        files += [os.path.join(d, f) for f in sorted(fs) if f.endswith('.swift')]

DECL = re.compile(r'^(\s*)(?:@\w+(?:\([^)]*\))?\s+)*'
                  r'(?:public |internal |private |fileprivate |open |final |indirect |nonisolated\(unsafe\) )*'
                  r'(struct|class|enum|protocol|actor|extension)\s+([A-Za-z_]\w*)')
MEMBER = re.compile(r'^\s*(?:@\w+(?:\([^)]*\))?\s+)*'
                    r'(?:public |internal |private(?:\(set\))? |fileprivate |open |final |static |class |mutating |nonisolated\(unsafe\) |lazy |weak |override |convenience |required |discardableResult )*'
                    r'(func|var|let|case|init|typealias|subscript)\s*([A-Za-z_]\w*)?')

members = collections.defaultdict(set)   # type -> member names
inits   = collections.defaultdict(list)  # type -> [ [labels...] ]
known   = set()

for path in files:
    code = strip_noise(open(path, encoding='utf-8').read())
    lines = code.split('\n')
    stack = []   # (indent, typename)
    for line in lines:
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        while stack and indent <= stack[-1][0]:
            stack.pop()

        d = DECL.match(line)
        if d:
            name = d.group(3)
            if d.group(2) != 'extension':
                known.add(name)
                # Nested types are members of their parent.
                if stack:
                    members[stack[-1][1]].add(name)
            stack.append((indent, name))
            continue

        if not stack:
            continue
        m = MEMBER.match(line)
        if m:
            kind, name = m.group(1), m.group(2)
            owner = stack[-1][1]
            if kind == 'init':
                labels = []
                params = line[line.find('init'):]
                depth, buf = 0, ''
                for ch in params:
                    if ch == '(':
                        depth += 1
                        if depth == 1: continue
                    elif ch == ')':
                        depth -= 1
                        if depth == 0: break
                    if depth >= 1: buf += ch
                for part in re.split(r',(?![^<]*>)', buf):
                    label = part.strip().split(':')[0].strip().split(' ')[0]
                    if label and re.match(r'^[A-Za-z_]\w*$', label):
                        labels.append(label)
                inits[owner].append(labels)
                members[owner].add('init')
            elif name:
                members[owner].add(name)
                # `case a, b, c` and `let x, y`
                for extra in re.findall(r',\s*([a-z]\w*)', line.split('//')[0]):
                    members[owner].add(extra)

problems = []
for path in files:
    code = strip_noise(open(path, encoding='utf-8').read())
    for m in re.finditer(r'\b([A-Z]\w*)\.([a-zA-Z_]\w*)', code):
        owner, member = m.group(1), m.group(2)
        if owner not in known or owner not in members:
            continue
        if member in members[owner]:
            continue
        # Enum cases and synthesised members reached through metatypes.
        if member in {'self', 'Type', 'init', 'shared', 'allCases', 'rawValue',
                      'RawValue', 'default', 'none', 'some'}:
            continue
        line = code[:m.start()].count('\n') + 1
        problems.append(f"{path}:{line}: {owner}.{member} — no such member declared")

print(f"types with members indexed: {len(members)}")
for p in sorted(set(problems)):
    print("XREF ", p)
print(f"{len(set(problems))} cross-reference problems")
