# AccountManager model-recovery evidence

이 문서는 `src/account-manager.js`와 `src/config.js`의 Codex 모델 호환성 의존성을 독립
검토 bundle에 안전하게 포함하기 위한 evidence입니다. 전체 파일은 아래 SHA-256으로
고정하고, 검토에 필요한 구간만 원문 그대로 옮겼습니다.

- Source: `src/account-manager.js`
- SHA-256: `02db40a4a20927a175a1e5d150bbd483b728b8be6674e0e93cbbf70bea472f08`
- Source: `src/config.js`
- SHA-256: `dd982f9cdc909071ae37785d67862b753a99fbbee26da5c373998b2f3e703959`
- 2026-09-08 갱신: 기본 브랜치 `09de69e`의 두 파일과 아래 발췌 구간을 대조했다.
  이후 두 소스가 바뀌면 이 문서와 `test/test_model_recovery_gate.py`의 핀을 함께 검토·갱신한다.
- 2026-10-07 갱신: 사용량 유예 차선(`usageLimitGrace`) 추가로 `src/account-manager.js`만 바뀌었다.
  아래 발췌 구간은 바뀐 소스와 줄 단위로 그대로 일치함을 대조했고, 모델 복구 로직은 변경 없다.
- 2026-10-09 갱신: 전송 실패 쿨다운(`markSendFailure`·`clearSendFailure` 등) 추가로 `src/account-manager.js`만 바뀌었다.
  아래 발췌 구간(`// ...` 생략 포함)은 바뀐 소스와 줄 단위·순서대로 일치함을 대조했고, 모델 복구 로직은 변경 없다.
- 2026-10-12 갱신: Codex 라우팅 기능 복구(쿼터 예약 `quotaReserve`, 상류 실패 회피 `noteUpstreamFailure`,
  유료 크레딧 라우팅 `codexUseCredits`)로 `src/account-manager.js`만 바뀌었다. `_isAvailable`의 포함 쿼터 판정이
  크레딧 경로를 갖게 되어 "Eligibility" 발췌를 바뀐 소스와 줄 단위·순서대로 맞췄다(`// ...` 생략 포함).
  모델 복구 로직(`_isModelUnsupported`·`markModelUnsupported`·`clearModelUnsupported`·`_recoverSoonest` 판정 순서)은 변경 없다.
- 2026-10-31 갱신: 5시간 창 없는 계정 기록(`quota.sessionWindowStated`, `_noteSessionWindow`)으로 `src/account-manager.js`만 바뀌었다.
  바뀐 곳은 `emptyQuota`·`_fullyMeasured`·`_isNearQuota`·`updateQuota`·`importQuotaState`이고 아래 발췌 구간은 건드리지 않았다.
  모델 복구 로직은 변경 없다.
- 2026-11-01 갱신: Anthropic API 키 크레딧 계층(`_initCredit`·`recordApiSpend`·`setCreditExhausted`·`_apiKeysUnlocked` 등)으로
  `src/account-manager.js`만 바뀌었다. `_isAvailable`에는 발췌 시작 전에 `creditExhausted` 판정이, 근접 쿼터 판정 뒤
  `// ...` 자리에 API 키 계층 잠금이 들어갔고, `_recoverSoonest`에는 `_isModelUnsupported` 앞 `// ...` 자리에
  `creditExhausted` 건너뛰기가 들어갔다. 아래 발췌 줄은 바뀐 소스와 줄 단위·순서대로 일치하고 모델 복구 로직은 변경 없다.
  같은 날 검토 수정(발송 도장 `creditDispatchStamp`·`setApiKey`·`reconcileCreditFlagFromDisk`, 영속 실패 재시도)도
  크레딧 메서드 안에서만 바뀌었고 발췌 구간은 그대로다.
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
    // ...
    if (this._isNearQuota(account, model)
        && !(allowCredits && this._creditRoutable(account, readOnly)
          && this._creditsUnlocked(model, scope, readOnly))) {
      return false;
    }
    // ...
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
