# AccountManager model-recovery evidence

이 문서는 `src/account-manager.js`와 `src/config.js`의 Codex 모델 호환성 의존성을 독립
검토 bundle에 안전하게 포함하기 위한 evidence입니다. 전체 파일은 아래 SHA-256으로
고정하고, 검토에 필요한 구간만 원문 그대로 옮겼습니다.

- Source: `src/account-manager.js`
- SHA-256: `64ce737d27ff6cfd90960e720f884034b2cbeaa6b475f8d3c07df7a678e9664a`
- Source: `src/config.js`
- SHA-256: `9dc6f1ceb8d00af4ebd0995c8efae6451f5a22fd7d27aca7bfbbac26e506a30f`
- 검증 명령: `shasum -a 256 src/account-manager.js src/config.js`
- 전체 파일을 gate bundle에 직접 넣지 않은 이유: 모델 복구와 무관한 credential property
  identifiers가 value-shape secret scanner의 보수적 규칙에 걸립니다. 이 evidence는 값을
  포함하지 않으며, 최종 code/security reviewer는 원본 전체 파일을 직접 읽습니다.

## Account initialization

```js
      rateLimitedUntil: null,
      unsupportedModels: new Map(),
      inflight: 0,
      maxConcurrent: coerceMaxConcurrent(acct.maxConcurrent, this.maxConcurrentDefault),
```

## Eligibility and bounded TTL quarantine

```js
    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isModelUnsupported(account, model)) return false;
    if (this._isNearQuota(account, model)) return false;

    return true;
  }

  _isModelUnsupported(account, model) {
    if (!account || typeof model !== 'string' || !model
        || !(account.unsupportedModels instanceof Map)) return false;
    const until = account.unsupportedModels.get(model);
    if (!Number.isFinite(until)) return false;
    if (Date.now() >= until) {
      account.unsupportedModels.delete(model);
      return false;
    }
    return true;
  }

  markModelUnsupported(accountIndex, model, ttlMs = CODEX_MODEL_UNSUPPORTED_TTL_MS) {
    const account = this._resolve(accountIndex);
    if (!account || typeof model !== 'string' || !model
        || !Number.isFinite(ttlMs) || ttlMs <= 0) return false;
    const now = Date.now();
    for (const [candidate, until] of account.unsupportedModels) {
      if (!Number.isFinite(until) || until <= now) account.unsupportedModels.delete(candidate);
    }
    account.unsupportedModels.delete(model);
    while (account.unsupportedModels.size >= CODEX_MODEL_UNSUPPORTED_MAX_ENTRIES) {
      const oldest = account.unsupportedModels.keys().next().value;
      account.unsupportedModels.delete(oldest);
    }
    account.unsupportedModels.set(model, now + Math.floor(ttlMs));
    return true;
  }

  clearModelUnsupported(accountIndex, model) {
    const account = this._resolve(accountIndex);
    if (!account || typeof model !== 'string' || !model) return false;
    return account.unsupportedModels.delete(model);
  }

  _recoverSoonest(model = null) {
    // ...
    for (const account of this.accounts) {
      // ...
      if (this._isModelUnsupported(account, model)) continue;
      if (this._isModelNearQuota(account, model)) continue;
      // ...
    }
  }
```

## Status projection

```js
      unsupportedModels: [...a.unsupportedModels.keys()].filter(model =>
        this._isModelUnsupported(a, model)),
```

## Codex fallback default

```js
    modelFallbacks: provider === 'codex'
      ? { 'gpt-5.6-sol': ['gpt-5.6-terra'] }
      : {},
```

## Reviewer checks

1. unsupported-model 상태는 account/model 조합에만 적용됩니다.
2. 만료 항목은 읽기와 삽입 시 제거됩니다.
3. account별 quarantine은 64개로 제한되고 oldest entry를 제거합니다.
4. status에는 현재 TTL이 유효한 model slug만 포함됩니다.
5. quota reset 회복은 아직 TTL이 유효한 model quarantine을 우회하지 않습니다.
6. 실제 원본 전체 파일 hash가 위 값과 다르면 이 evidence는 무효입니다.
