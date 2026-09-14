"""Port of Timeline.index(at:) — the cursor-cached galloping search from §8.3 —
checked against a brute-force reference over adversarial access patterns."""
import random, bisect

class Timeline:
    def __init__(self, starts):
        self.starts = starts
        self.cursor = 0

    def contains(self, index, time):
        if not (0 <= index < len(self.starts)): return False
        start = self.starts[index]
        nxt = self.starts[index+1] if index + 1 < len(self.starts) else float('inf')
        return start <= time < nxt

    def index(self, time):
        w = self.starts
        if not w: return None
        if time <= w[0]:
            self.cursor = 0; return 0
        if time >= w[-1]:
            self.cursor = len(w) - 1; return self.cursor

        if self.contains(self.cursor, time): return self.cursor
        if self.cursor + 1 < len(w) and self.contains(self.cursor + 1, time):
            self.cursor += 1; return self.cursor

        lo, hi = 0, len(w) - 1
        if time > w[self.cursor]:
            lo = self.cursor
            step = 1
            while lo + step < len(w) and w[lo + step] <= time:
                lo += step; step <<= 1
            hi = min(len(w) - 1, lo + step)
        else:
            hi = self.cursor
            step = 1
            while hi - step >= 0 and w[hi - step] > time:
                hi -= step; step <<= 1
            lo = max(0, hi - step)

        while lo < hi:
            mid = (lo + hi + 1) // 2
            if w[mid] <= time: lo = mid
            else: hi = mid - 1
        self.cursor = lo
        return lo

def reference(starts, time):
    """Last index whose start <= time, clamped at both ends."""
    if not starts: return None
    if time <= starts[0]: return 0
    if time >= starts[-1]: return len(starts) - 1
    return bisect.bisect_right(starts, time) - 1

random.seed(7)
failures = 0
patterns = {
    'monotonic forward': lambda n: [i * 0.07 for i in range(int(n * 14))],
    'monotonic backward': lambda n: [(n * 0.5 - i * 0.07) for i in range(int(n * 14))],
    'random scrub': lambda n: [random.uniform(-2, n * 0.6) for _ in range(4000)],
    'alternating ends': lambda n: [(0.01 if i % 2 else n * 0.49) for i in range(2000)],
    'exact boundaries': lambda n: [i * 0.5 for i in range(n)],
}

for count in [1, 2, 3, 17, 500, 5000]:
    starts = [i * 0.5 for i in range(count)]
    for name, gen in patterns.items():
        line = Timeline(starts)
        for t in gen(count):
            got, want = line.index(t), reference(starts, t)
            if got != want:
                print(f"  FAIL n={count} {name}: t={t} got {got} want {want}")
                failures += 1
                break
    # Non-uniform spacing, which is what real durations look like.
    starts = []
    acc = 0.0
    for _ in range(count):
        starts.append(acc)
        acc += random.uniform(0.05, 1.4)
    line = Timeline(starts)
    for t in [random.uniform(-1, acc + 1) for _ in range(3000)]:
        got, want = line.index(t), reference(starts, t)
        if got != want:
            print(f"  FAIL n={count} non-uniform: t={t} got {got} want {want}")
            failures += 1
            break
    print(f"  n={count:5} all patterns agree with brute force" if failures == 0 else "")

print(f"\n{failures} disagreements with the reference implementation")
