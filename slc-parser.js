
const SLC_HEADER = [83, 76, 67, 51, 82, 80, 76, 89];
const SLC_FOOTER = 0xCC;

function parseSLC(buffer) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer);

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  let pos = 0;

  function need(n) {
    if (n < 0 || pos + n > bytes.length) {
      throw new Error("Повреждённый SLC: неожиданный конец файла");
    }
  }

  function u8() {
    need(1);
    return view.getUint8(pos++);
  }

  function u16() {
    need(2);
    const v = view.getUint16(pos, true);
    pos += 2;
    return v;
  }

  function u32() {
    need(4);
    const v = view.getUint32(pos, true);
    pos += 4;
    return v;
  }

  function u64() {
    need(8);
    const v = view.getBigUint64(pos, true);
    pos += 8;
    return v;
  }

  function f64() {
    need(8);
    const v = view.getFloat64(pos, true);
    pos += 8;
    return v;
  }

  function readDelta(size) {
    need(size);
    let value = 0n;
    for (let i = size - 1; i >= 0; i--) {
      value = (value << 8n) | BigInt(bytes[pos + i]);
    }
    pos += size;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Слишком большое значение кадра");
    }
    return Number(value);
  }

  need(8);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SLC_HEADER[i]) {
      throw new Error("Это не SLC v3 (нет заголовка SLC3RPLY)");
    }
  }
  pos = 8;

  const metaSize = u16();
  if (metaSize !== 64) {
    throw new Error(`Неизвестный размер метаданных: ${metaSize}`);
  }

  const tps = f64();
  const seed = u64().toString();
  const version = u32();
  const build = u32();
  const randomnessAlgorithm = u32();

  pos += 36; // padding метаданных

  const actions = [];
  let frame = 0;

  function add(type, holding, player2, delta, extra = {}) {
    frame += delta;
    actions.push({
      frame,
      type,
      holding,
      player2,
      ...extra
    });
  }

  function readInputs(count, byteSize, repeat = 1) {
    const pattern = [];
    let patternFrame = 0;

    for (let i = 0; i < count; i++) {
      const state = readDelta(byteSize);
      const delta = Math.floor(state / 16);
      const button = (state >> 2n) & 3n;
      const holding = (state & 1n) !== 0n;
      const player2 = (state & 2n) !== 0n;

      patternFrame += delta;
      pattern.push({ delta, button: Number(button), holding, player2 });
    }

    for (let r = 0; r < repeat; r++) {
      for (const input of pattern) {
        if (input.button === 0) {
          // Swift — короткое нажатие Jump.
          add("Jump", true, input.player2, input.delta, {
            swift: true
          });
          add("Jump", false, input.player2, 0, {
            swift: true
          });
        } else {
          const names = ["Swift", "Jump", "Left", "Right"];
          add(
            names[input.button],
            input.holding,
            input.player2,
            input.delta
          );
        }
      }
    }
  }

  while (pos < bytes.length - 1) {
    const atomId = u32();
    const rawSize = u64();
    const size = Number(rawSize & 0x00FFFFFFFFFFFFFFn);
    const atomEnd = pos + size;

    if (!Number.isSafeInteger(size) || atomEnd > bytes.length - 1) {
      throw new Error("Некорректный размер атома");
    }

    if (atomId !== 1) {
      pos = atomEnd; // неизвестный атом пропускаем
      continue;
    }

    const countBig = u64();
    if (countBig > 10_000_000n) {
      throw new Error("Слишком много действий в реплее");
    }
    const actionCount = Number(countBig);
    const actionsBefore = actions.length;

    while (actions.length - actionsBefore < actionCount) {
      const header = u16();
      const id = header >> 14;

      if (id === 0 || id === 1) {
        const deltaSize = 1 << ((header >> 12) & 3);
        const count = 1 << ((header >> 8) & 15);
        const repeats = id === 1
          ? 1 << ((header >> 3) & 31)
          : 1;

        readInputs(count, deltaSize, repeats);
      } else if (id === 2) {
        const type = (header >> 10) & 15;
        const deltaSize = 1 << ((header >> 8) & 3);
        const delta = readDelta(deltaSize);

        if (type === 3) {
          add("TPS", false, false, delta, { tps: f64() });
        } else if (type <= 2) {
          const seedValue = u64().toString();
          add(
            ["Restart", "RestartFull", "Death"][type],
            false,
            false,
            delta,
            { seed: seedValue }
          );
        } else if (type === 4) {
          add("Bugpoint", false, false, delta);
        } else {
          throw new Error(`Неизвестный Special type: ${type}`);
        }
      } else {
        throw new Error(`Неизвестная секция: ${id}`);
      }

      if (pos > atomEnd) {
        throw new Error("Секция вышла за границы атома");
      }
    }

    if (pos !== atomEnd) {
      throw new Error("Размер ActionAtom не совпал с его содержимым");
    }
  }

  if (bytes[bytes.length - 1] !== SLC_FOOTER) {
    throw new Error("Не найден маркер конца SLC");
  }

  return {
    format: "SLC3RPLY",
    metadata: { tps, seed, version, build, randomnessAlgorithm },
    actionCount: actions.length,
    actions
  };
}
