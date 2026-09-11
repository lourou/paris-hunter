# Paris Hunter Meublé/Coloc Exclusion Fix — Summary

## Problem Statement
Furnished (meublé) and colocation listings were bypassing the pipeline post-filter and producing Convos notifications despite being hard-excluded in the project brief (docs/BRIEF-paris-hunter.md).

## Investigation & Root Cause

### Methodology
1. Analyzed existing exclusion patterns in `lib/services/paris-hunter/exclusions.js`
2. Traced data flow: Stream Estate → normalize → local post-filter → scoring → Convos
3. Tested regex patterns against real-world French/English variants
4. Reviewed existing test coverage and fixtures

### Root Cause: Pattern Gaps

**Furnished Pattern Gap:**
- Original: `/\bmeuble/` 
- ❌ Missed: `mobilier`, `avec meubles`, `furnished` (English)
- While `meublé` → `meuble` after normalization worked, synonyms weren't caught

**Colocation Pattern Gap:**
- Original: `/\bcoloc(?:ation)?s?\b/`
- ❌ Missed: `colocataire`, `coliving`, `flat-sharing`, `cohabitation`, `roommate`
- Pattern assumed `coloc` + optional `ation` suffix, but real variants use different suffixes

**Negation Handling Gap:**
- Original: Only stripped `meuble` negations (`non meublé`, `pas meublé`)
- ❌ Missed: `sans mobilier`, `pas de meubles`

## Solution Implementation

### Enhanced Regex Patterns

```javascript
// Furnished exclusion (comprehensive)
['meuble', /\bmeuble(?:e|es|s)?\b|\bmobilier\b|\bavec[-\s]+meubles?\b|\bfurnished\b/]

// Colocation exclusion (comprehensive)
['coloc', /\bcoloc(?:ation|ataires?)?s?\b|\bcoliving\b|\bflat[-\s]?shar(?:e|ing)\b|\bcohabitation\b|\broommate/]
```

### Enhanced Negation Handling
```javascript
const NEGATED_FURNISHED = /\b(?:non|pas|sans)(?:[-\s]+)(?:(?:de|du|un|une|le|les)(?:[-\s]+))?(?:meuble(?:e|es|s)?|mobilier|meubles)\b/g;
```

### Text Normalization Pipeline
Unchanged, continues to handle:
1. Case folding (`toLocaleLowerCase('fr-FR')`)
2. Unicode normalization (NFD)
3. Diacritic removal (`é` → `e`)
4. Whitespace normalization

## Testing & Verification

### Test Coverage
- **55 exclusion unit tests** (23 new)
  - 10 furnished variants
  - 11 colocation variants  
  - 34 other exclusions + negations
- **44 Stream Estate provider tests** (3 new)
  - End-to-end integration tests with full payloads
- **617 total tests** — all passing

### Manual Verification Results
```
✓ Appartement meublé                → excluded:meuble
✓ Location avec meubles             → excluded:meuble
✓ Mobilier fourni                   → excluded:meuble
✓ Furnished apartment               → excluded:meuble
✓ Cherche colocataire               → excluded:coloc
✓ Coliving Paris                    → excluded:coloc
✓ Flat-sharing available            → excluded:coloc
✓ Cohabitation étudiante            → excluded:coloc

✓ Appartement non meublé            → PASS (not excluded)
✓ Sans mobilier                     → PASS (not excluded)
✓ Pas de meubles                    → PASS (not excluded)
```

### Edge Cases Verified
- ✅ Negations with articles: "pas de meubles", "sans le mobilier"
- ✅ Hyphenated variants: "flat-sharing", "non-meublé"
- ✅ Mixed exclusions: "Appartement non meublé, colocation possible" → catches coloc after removing meublé negation
- ✅ Civil lease protection: "bail civil", "bail code civil" → never excluded
- ✅ Case insensitivity: "FURNISHED", "COLIVING" → caught
- ✅ Accent handling: "meublé" → "meuble", "colocataire" → "colocataire" → caught

## Impact & Acceptance Criteria

### Acceptance Criterion Met
✅ **"Meublé / coloc / out-of-budget / out-of-area listings never notify"**
- Meublé exclusion: ✅ Complete (all documented variants)
- Coloc exclusion: ✅ Complete (all documented variants)

### Unchanged Behavior
- ✅ Structured `furnished: true` flag check preserved
- ✅ Other exclusions (bail mobilité, courte durée, etc.) unchanged
- ✅ Scoring and notification behavior unchanged
- ✅ No false positives on clean unfurnished listings

## Files Modified

1. **`lib/services/paris-hunter/exclusions.js`**
   - Enhanced `EXCLUSIONS` patterns (meuble + coloc)
   - Enhanced `NEGATED_FURNISHED` pattern

2. **`test/services/paris-hunter/exclusions.test.js`**
   - Added 23 new test cases
   - Organized into describe blocks (furnished, colocation, other)
   - Added negation edge cases

3. **`test/provider/streamEstate.test.js`**
   - Added 3 integration tests (colocataire, coliving, mobilier)

4. **Test Fixtures (new)**
   - `test/mocks/streamEstate/match-colocataire.json`
   - `test/mocks/streamEstate/match-coliving.json`
   - `test/mocks/streamEstate/match-mobilier.json`

## Deployment Notes

- ✅ Backward compatible — no breaking changes
- ✅ No configuration changes required
- ✅ No database migrations needed
- ✅ All existing tests pass (617/617)
- ✅ Linter passes (eslint + prettier)

## Future Considerations

### Potential Additions (not in scope)
- "équipé" (equipped) — too ambiguous (can mean just kitchen equipped)
- "avec cuisine équipée" — false positive risk
- "mobilier complet" — already caught by `\bmobilier\b`

### Monitoring Recommendations
1. Track `excluded:meuble` and `excluded:coloc` decision counts
2. Monitor for new variants in production logs
3. Review Stream Estate `furnished: false` filter effectiveness

---

**Status:** ✅ Ready for review  
**Tests:** ✅ 617/617 passing  
**Linter:** ✅ Passing  
**Branch:** `cursor/fix-paris-hunter-meuble-coloc-exclusions-91e5`  
**PR:** https://github.com/lourou/paris-hunter/pull/1
