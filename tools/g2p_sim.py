"""Faithful Python port of FallbackPhonemizer, to run the logic I can't compile."""
import re, sys

lex = open('Sources/PolyReadLinguistics/FallbackLexicon.swift').read()
stress_src = open('Sources/PolyReadLinguistics/Stress.swift').read()

def block(text, start, end):
    return text[text.index(start):text.index(end)]

defaults = dict(re.findall(r'"([^"]+)":\s*"([^"]*)"',
                block(lex, 'static let defaults', 'static let rules')))
exceptions = dict(re.findall(r'"([^"]+)":\s*"([^"]*)"',
                  block(lex, 'static let exceptions', 'static let letterNames')))

RULE = re.compile(r'\.init\(\.(\w+)(?:\("([^"]*)"\))?,\s*"([^"]+)",\s*\.(\w+)(?:\("([^"]*)"\))?,\s*"([^"]*)"\)')
rules = []
for lc, la, pattern, rc, ra, ph in RULE.findall(lex):
    rules.append(dict(left=(lc, la), pattern=pattern, right=(rc, ra), phonemes=ph))
by_pattern = {}
for r in rules:
    by_pattern.setdefault(r['pattern'], []).append(r)
LONGEST = int(re.search(r'static let longestPattern = (\d+)', lex).group(1))

def ctx_matches(kind, arg, letters, index, forward):
    if kind == 'anything': return True
    if kind == 'wordEnd':  return index >= len(letters) if forward else index < 0
    if kind == 'notWordEnd': return index < len(letters) if forward else index >= 0
    if kind == 'vowel':
        return 0 <= index < len(letters) and letters[index] in 'aeiouy'
    if kind == 'consonant':
        return 0 <= index < len(letters) and letters[index].isalpha() and letters[index] not in 'aeiou'
    if kind == 'literal':
        chars = list(arg)
        if forward:
            if index + len(chars) > len(letters): return False
            return letters[index:index+len(chars)] == chars
        start = index - len(chars) + 1
        if start < 0 or index >= len(letters): return False
        return letters[start:index+1] == chars
    raise AssertionError(kind)

def apply_rules(letters):
    out, i = '', 0
    while i < len(letters):
        matched = False
        for length in range(min(LONGEST, len(letters) - i), 0, -1):
            candidate = ''.join(letters[i:i+length])
            for rule in by_pattern.get(candidate, []):
                if not ctx_matches(*rule['left'], letters, i - 1, False): continue
                if not ctx_matches(*rule['right'], letters, i + length, True): continue
                out += rule['phonemes']
                i += length
                matched = True
                break
            if matched: break
        if not matched:
            out += defaults.get(letters[i], '')
            i += 1
    return out

NUCLEI = set(re.search(r'static let vowelNuclei: Set<Character> = \[(.*?)\]', stress_src, re.S)
             .group(1).replace('"', '').replace('\n', '').replace(' ', '').split(','))
NUCLEI.discard('')
PREFIXES = re.findall(r'"(\w+)"', block(stress_src, 'static let unstressedPrefixes', 'static let prestressSuffixes'))
SUFFIXES = re.findall(r'"(\w+)"', block(stress_src, 'static let prestressSuffixes', 'static func assignIfPolysyllabic'))

def syllable_count_phonemes(ph):
    count, prev = 0, False
    for c in ph:
        is_n = c in NUCLEI
        if is_n and not prev: count += 1
        prev = is_n
    return count

def syllable_count_spelling(s):
    count, prev = 0, False
    for c in s:
        is_v = c in 'aeiouy'
        if is_v and not prev: count += 1
        prev = is_v
    return count

def assign(ph, spelling):
    if not ph or 'ˈ' in ph: return ph
    chars = list(ph)
    nuclei = [i for i, c in enumerate(chars) if c in NUCLEI]
    syllables = []
    for i in nuclei:
        if syllables and i == syllables[-1] + 1: continue
        syllables.append(i)
    if not syllables: return ph
    if len(syllables) == 1:
        return insert(chars, syllables[0])
    target = 0
    suffix = next((s for s in SUFFIXES if spelling.endswith(s)), None)
    if suffix:
        target = max(0, len(syllables) - max(1, syllable_count_spelling(suffix)) - 1)
    elif any(spelling.startswith(p) for p in PREFIXES) and len(syllables) >= 2:
        target = 1
    return insert(chars, syllables[target])

VALID_ONSETS = {'fɹ', 'kj', 'sn', 'ʃɹ', 'st', 'sm', 'ɡɹ', 'bl', 'sl', 'kl', 'tɹ', 'mj', 'kw', 'tw', 'sk', 'dw', 'hj', 'bɹ', 'θw', 'sj', 'pj', 'pl', 'pɹ', 'vj', 'ɡl', 'tj', 'sw', 'θɹ', 'kɹ', 'fl', 'lj', 'fj', 'sp', 'dɹ', 'bj', 'nj'}

def insert(chars, nucleus):
    cluster_start = nucleus
    while cluster_start > 0 and chars[cluster_start-1] not in NUCLEI:
        cluster_start -= 1
    if cluster_start == 0:
        onset = 0
    else:
        cluster = chars[cluster_start:nucleus]
        if len(cluster) >= 2:
            if len(cluster) >= 3 and cluster[-3] == 's' and ''.join(cluster[-2:]) in VALID_ONSETS:
                onset = nucleus - 3
            elif ''.join(cluster[-2:]) in VALID_ONSETS:
                onset = nucleus - 2
            else:
                onset = nucleus - 1
        else:
            onset = cluster_start
    return ''.join(chars[:onset]) + 'ˈ' + ''.join(chars[onset:])

def assign_if_polysyllabic(ph, spelling):
    if 'ˈ' in ph or syllable_count_phonemes(ph) <= 1: return ph
    return assign(ph, spelling)

def convert_word(word):
    low = word.lower()
    if low in exceptions:
        return assign_if_polysyllabic(exceptions[low], low)
    return assign(apply_rules(list(low)), low)

if __name__ == '__main__':
    print("=== the stress test's words ===")
    for w in ["politics", "democracy", "institution", "reconsider", "comparative"]:
        ph = convert_word(w)
        marks = ph.count('ˈ')
        print(f"  {w:14} {ph:24} marks={marks} {'OK' if marks == 1 else 'FAIL'}")

    print("\n=== function words must stay unstressed ===")
    for w in ["the", "of", "as", "was", "in"]:
        ph = convert_word(w)
        print(f"  {w:14} {ph:24} {'OK' if 'ˈ' not in ph else 'FAIL'}")

    print("\n=== a real sentence through the rules ===")
    sentence = ("Comparative politics has long treated the consolidation of democratic "
                "institutions as a function of economic development, but the evidence "
                "for that relationship is weaker than the literature suggests.")
    for w in sentence.split():
        core = w.strip('.,;:()')
        print(f"  {core:16} {convert_word(core)}")
