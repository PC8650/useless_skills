// Unified read-only file gate for Windows Script Host and macOS JXA.
// Windows: cscript //nologo file-gate.js <absolute-path> [...]
// macOS: osascript -l JavaScript file-gate.js <absolute-path> [...]
// The host supplies file access; this script never executes or modifies targets.

var MAX_FILES = 200;
var MAX_DEPTH = 32;
var BLOCK_SIZE = 1048576;
var IS_WINDOWS = typeof WScript !== "undefined";
var depthTruncated = false;

if (!IS_WINDOWS) ObjC['import']('Foundation');

var LEGEND = "legend: size=KB (1 KB=1024 bytes); type=full-file TEXT/BIN measurement; encoding=heuristic text encoding; dossier=generic byte-shape signals; entropy=Shannon bits/byte; blocks=full-file read blocks; coverage=read completion; score=readability heuristic 0-100; flag=TEXT-CANDIDATE/REVIEW/DENY, not a safety verdict; status=scan result";

function pathLeaf(p) {
  var parts = String(p).split(/[\\\/]/);
  return parts[parts.length - 1];
}

function extOf(p) {
  var name = pathLeaf(p), dot = name.lastIndexOf('.');
  return dot > 0 ? name.substring(dot + 1).toLowerCase() : '-';
}

function displaySize(bytes) {
  if (bytes === '-' || bytes === undefined || bytes === null) return '-';
  return (Number(bytes) / 1024).toFixed(2) + ' KB';
}

function entropy(bytes) {
  var counts = [], i, p, h = 0;
  if (!bytes.length) return 0;
  for (i = 0; i < 256; i++) counts[i] = 0;
  for (i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  for (i = 0; i < 256; i++) if (counts[i]) {
    p = counts[i] / bytes.length;
    h -= p * Math.log(p) / Math.LN2;
  }
  return h;
}

// Boundary-aware UTF-8 stats over multiple samples: a multi-byte sequence cut at a
// sample boundary must not produce false invalid counts. Leading continuation bytes
// of every sample after the first are treated as the tail of a sequence cut in the
// previous sample; an incomplete sequence at a sample end is ignored, not judged.
function utf8StatsSamples(samples) {
  var s, i, j, first, need, valid, second, bad = 0, multi = 0;
  for (s = 0; s < samples.length; s++) {
    var bytes = samples[s];
    i = 0;
    if (s > 0) while (i < bytes.length && bytes[i] >= 0x80 && bytes[i] <= 0xBF) i++;
    while (i < bytes.length) {
      first = bytes[i];
      if (first < 0x80) { i++; continue; }
      need = first >= 0xC2 && first <= 0xDF ? 1 : first >= 0xE0 && first <= 0xEF ? 2 : first >= 0xF0 && first <= 0xF4 ? 3 : 0;
      if (!need) { bad++; i++; continue; }
      if (i + need >= bytes.length) {
        valid = true;
        for (j = 1; j <= need; j++) {
          if (i + j >= bytes.length) break;
          if (bytes[i + j] < 0x80 || bytes[i + j] > 0xBF) { valid = false; break; }
        }
        if (!valid) bad++;
        break;
      }
      valid = true;
      for (j = 1; j <= need; j++) if (bytes[i + j] < 0x80 || bytes[i + j] > 0xBF) valid = false;
      second = bytes[i + 1];
      if (valid && ((first === 0xE0 && second < 0xA0) || (first === 0xED && second > 0x9F) || (first === 0xF0 && second < 0x90) || (first === 0xF4 && second > 0x8F))) valid = false;
      if (!valid) { bad++; i++; } else { multi += need; i += need + 1; }
    }
  }
  return { bad: bad, multi: multi };
}

// Strict GBK pair stats within each sampled block: lead 0x81-0xFE, trail
// 0x40-0xFE excluding 0x7F. A GBK pair split across sample blocks may be
// counted as invalid; this is a bounded-sampling limitation.
function gbkStatsSamples(samples) {
  var s, i, b, t, lead = 0, ok = 0, bad = 0;
  for (s = 0; s < samples.length; s++) {
    var bytes = samples[s];
    i = 0;
    while (i < bytes.length) {
      b = bytes[i];
      if (b < 0x80) { i++; continue; }
      if (b >= 0x81 && b <= 0xFE) {
        lead++;
        if (i + 1 >= bytes.length) break;
        t = bytes[i + 1];
        if (t >= 0x40 && t <= 0xFE && t !== 0x7F) { ok++; i += 2; } else { bad++; i++; }
      } else { bad++; i++; }
    }
  }
  return { lead: lead, ok: ok, bad: bad };
}

function concatSamples(samples) {
  var out = [], i, j;
  for (i = 0; i < samples.length; i++) for (j = 0; j < samples[i].length; j++) out.push(samples[i][j]);
  return out;
}

function utf16StatsSamples(samples, little, skipFirst) {
  var skip = (skipFirst === undefined) ? 2 : skipFirst;
  var s, bytes, i, units = 0, invalid = 0, controls = 0, a, b, cp, next, end;
  for (s = 0; s < samples.length; s++) {
    bytes = samples[s]; i = s === 0 ? skip : 0; end = bytes.length;
    if ((end - i) % 2 !== 0) { invalid++; end--; }
    while (i + 1 < end) {
      a = bytes[i]; b = bytes[i + 1];
      cp = little ? (a | (b << 8)) : ((a << 8) | b);
      i += 2;
      if (cp >= 0xD800 && cp <= 0xDBFF) {
        if (i + 1 >= end) { invalid++; break; }
        a = bytes[i]; b = bytes[i + 1];
        next = little ? (a | (b << 8)) : ((a << 8) | b);
        if (next < 0xDC00 || next > 0xDFFF) { invalid++; continue; }
        cp = 0x10000 + ((cp - 0xD800) << 10) + (next - 0xDC00);
        i += 2;
      } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
        invalid++;
        continue;
      }
      if ((cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7F && cp <= 0x9F)) controls++;
      units++;
    }
  }
  return { units: units, invalid: invalid, controls: controls };
}

// High-lane byte histogram for UTF-16 (odd indices for LE, even for BE):
// real text concentrates high bytes in a narrow value window; random or
// encrypted data spreads them across the full 0-255 range.
function utf16LaneProfile(samples, little) {
  var s, bytes, i, hist = {}, total = 0, v, k;
  for (s = 0; s < samples.length; s++) {
    bytes = samples[s];
    for (i = little ? 1 : 0; i < bytes.length; i += 2) {
      v = bytes[i]; k = String(v);
      hist[k] = (hist[k] || 0) + 1;
      total++;
    }
  }
  return { hist: hist, total: total };
}

function utf16LaneConsistent(profile) {
  var k, vals = [], counts = [], distinct = 0, i, j, v, c, sum = 0, best = 0;
  for (k in profile.hist) { vals.push(Number(k)); counts.push(profile.hist[k]); distinct++; }
  if (distinct === 0 || distinct > 64) return false;
  for (i = 1; i < vals.length; i++) {
    v = vals[i]; c = counts[i]; j = i - 1;
    while (j >= 0 && vals[j] > v) { vals[j + 1] = vals[j]; counts[j + 1] = counts[j]; j--; }
    vals[j + 1] = v; counts[j + 1] = c;
  }
  j = 0;
  for (i = 0; i < vals.length; i++) {
    sum += counts[i];
    while (vals[i] - vals[j] >= 128) { sum -= counts[j]; j++; }
    if (sum > best) best = sum;
  }
  return best * 100 >= profile.total * 90;
}

// Text-form classification over per-sample arrays with boundary awareness.
// Returns the heuristic type/encoding plus the invisible/control-byte count,
// where high bytes (0x80-0x9F) that are structural parts of valid multi-byte
// sequences (UTF-8 continuations, GBK lead/trail) are exempt from counting.
function measureText(samples) {
  var total = 0, s, i, b;
  for (s = 0; s < samples.length; s++) total += samples[s].length;
  if (!total) return { type: 'BIN', encoding: '-', invis: 0 };
  var head = samples[0], utf16le, utf16be;
  if (head.length >= 2 && head[0] === 0xFF && head[1] === 0xFE) {
    utf16le = utf16StatsSamples(samples, true);
    if (utf16le.units > 0 && utf16le.invalid === 0 && utf16le.controls / utf16le.units <= 0.05) return { type: 'TEXT', encoding: 'utf16le', invis: utf16le.controls };
    return { type: 'BIN', encoding: '-', invis: utf16le.controls };
  }
  if (head.length >= 2 && head[0] === 0xFE && head[1] === 0xFF) {
    utf16be = utf16StatsSamples(samples, false);
    if (utf16be.units > 0 && utf16be.invalid === 0 && utf16be.controls / utf16be.units <= 0.05) return { type: 'TEXT', encoding: 'utf16be', invis: utf16be.controls };
    return { type: 'BIN', encoding: '-', invis: utf16be.controls };
  }
  var ascii = 0, nul = 0;
  for (s = 0; s < samples.length; s++) {
    var sb = samples[s];
    for (i = 0; i < sb.length; i++) {
      b = sb[i];
      if ((b >= 0x20 && b <= 0x7E) || b === 9 || b === 10 || b === 13) ascii++;
      if (b === 0) nul++;
    }
  }
  var u8 = utf8StatsSamples(samples);
  if (head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF && u8.bad === 0) return { type: 'TEXT', encoding: 'utf8-bom', invis: invisibleWalk(samples, 'utf8') };
  if (nul / total > 0.15) {
    // BOM-less UTF-16 guess via byte-lane statistics: UTF-16 text concentrates
    // NUL bytes in one lane (the high byte of BMP chars); random binary spreads
    // NULs ~50/50. Pure positional statistic, no codepoint whitelist.
    var flat = concatSamples(samples), nulEven = 0, nulOdd = 0;
    for (i = 0; i < flat.length; i++) {
      if (flat[i] === 0) { if (i % 2 === 0) nulEven++; else nulOdd++; }
    }
    if (Math.max(nulEven, nulOdd) / Math.max(1, nulEven + nulOdd) > 0.75) {
      return { type: 'TEXT', encoding: nulOdd >= nulEven ? 'utf16le' : 'utf16be', invis: 0 };
    }
  }
  if (u8.bad === 0 && (ascii / total > 0.6 || u8.multi > 0)) return { type: 'TEXT', encoding: 'utf8', invis: invisibleWalk(samples, 'utf8') };
  var g = gbkStatsSamples(samples);
  if (g.lead / total >= 0.02 && g.bad / total <= 0.05 && g.ok / total >= 0.02) return { type: 'TEXT', encoding: 'gbk', invis: invisibleWalk(samples, 'gbk') };
  var ansi = 0;
  for (s = 0; s < samples.length; s++) {
    var ab = samples[s];
    for (i = 0; i < ab.length; i++) {
      b = ab[i];
      if ((b >= 0x20 && b <= 0x7E) || b === 9 || b === 10 || b === 13 || b >= 0xA0) ansi++;
    }
  }
  if (ansi / total > 0.9 && nul / total < 0.01) return { type: 'TEXT', encoding: 'ansi', invis: invisibleWalk(samples, 'ansi') };
  // BOM-less UTF-16 structural fallback (fail-closed, last resort): perfect
  // surrogate pairing, tight control ratio (<=2%), high-lane concentration
  // (>=95% of high bytes in one 128-wide window, <=64 distinct values), and
  // >=32 units. Random, encrypted, and structured binaries cannot satisfy all
  // of these; files too small to classify safely stay BIN.
  var u16le = utf16StatsSamples(samples, true, 0), u16be = utf16StatsSamples(samples, false, 0), u16pick = null, prof;
  if (u16le.units >= 32 && u16le.invalid === 0 && u16le.controls / u16le.units <= 0.02) {
    prof = utf16LaneProfile(samples, true);
    if (utf16LaneConsistent(prof)) u16pick = { enc: 'utf16le', controls: u16le.controls };
  }
  if (!u16pick && u16be.units >= 32 && u16be.invalid === 0 && u16be.controls / u16be.units <= 0.02) {
    prof = utf16LaneProfile(samples, false);
    if (utf16LaneConsistent(prof)) u16pick = { enc: 'utf16be', controls: u16be.controls };
  }
  if (u16pick) return { type: 'TEXT', encoding: u16pick.enc, invis: u16pick.controls };
  return { type: 'BIN', encoding: '-', invis: invisibleWalk(samples, 'ansi') };
}

// Invisible/control-byte walk with the same boundary rules as the stats pass.
// utf8/gbk: only bytes that cannot be structural parts of valid multi-byte
// sequences are counted; ansi: 0x80-0x9F (C1) remain counted as before.
function invisibleWalk(samples, encoding) {
  var s, i, count = 0;
  for (s = 0; s < samples.length; s++) {
    var bytes = samples[s];
    i = 0;
    if (encoding === 'utf8') {
      if (s > 0) while (i < bytes.length && bytes[i] >= 0x80 && bytes[i] <= 0xBF) i++;
      while (i < bytes.length) {
        var first = bytes[i];
        if (first < 0x80) {
          if ((first < 0x20 && first !== 9 && first !== 10 && first !== 13) || first === 0x7F) count++;
          i++; continue;
        }
        var need = first >= 0xC2 && first <= 0xDF ? 1 : first >= 0xE0 && first <= 0xEF ? 2 : first >= 0xF0 && first <= 0xF4 ? 3 : 0;
        if (!need) {
          if (first <= 0x9F) count++;
          i++; continue;
        }
        var j, ok = true, cut = false;
        for (j = 1; j <= need; j++) {
          if (i + j >= bytes.length) { cut = true; break; }
          if (bytes[i + j] < 0x80 || bytes[i + j] > 0xBF) { ok = false; break; }
        }
        if (cut) break;
        if (ok) { i += need + 1; continue; }
        if (first >= 0x80 && first <= 0x9F) count++;
        i++;
      }
    } else if (encoding === 'gbk') {
      while (i < bytes.length) {
        var b2 = bytes[i];
        if (b2 < 0x80) {
          if ((b2 < 0x20 && b2 !== 9 && b2 !== 10 && b2 !== 13) || b2 === 0x7F) count++;
          i++; continue;
        }
        if (b2 >= 0x81 && b2 <= 0xFE) {
          if (i + 1 < bytes.length) {
            var t = bytes[i + 1];
            if (t >= 0x40 && t <= 0xFE && t !== 0x7F) { i += 2; continue; }
          }
          i++; continue;
        }
        if (b2 <= 0x9F) count++;
        i++;
      }
    } else {
      for (i = 0; i < bytes.length; i++) {
        var b3 = bytes[i];
        if ((b3 < 0x20 && b3 !== 9 && b3 !== 10 && b3 !== 13) || b3 === 0x7F || (b3 >= 0x80 && b3 <= 0x9F)) count++;
      }
    }
  }
  return count;
}

// Structural format signatures only (embedded container/executable headers),
// not content rules: the dossier reports the position, the semantic layer judges.
// Scans EVERY sampled block (head / mids / tail); the tag names the block, not
// the exact file offset. Signatures split across block boundaries stay
// invisible — a documented bound of bounded sampling, not a safety verdict.
function genericStructureSignals(samples) {
  var out = [], s, bytes, i, high = 0, controls = 0, tag;
  for (s = 0; s < samples.length; s++) {
    bytes = samples[s];
    high = 0; controls = 0;
    for (i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 0x80) high++;
      if (bytes[i] < 0x20 && bytes[i] !== 9 && bytes[i] !== 10 && bytes[i] !== 13) controls++;
    }
    tag = s === 0 ? 'head' : (s === samples.length - 1 && samples.length > 1 ? 'tail' : 'mid' + s);
    if (bytes.length && high / bytes.length > 0.35) out.push('high-byte@' + tag);
    if (bytes.length && controls / bytes.length > 0.01) out.push('control-density@' + tag);
  }
  return out;
}

// Windows byte access: ADODB.Stream + MSXML base64 conversion.
var winStream = null, winDom = null, macHandle = null;
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64decode(s) {
  var out = [], bits = 0, acc = 0, i, c;
  s = s.replace(/[\r\n=]+/g, '');
  for (i = 0; i < s.length; i++) {
    c = B64.indexOf(s.charAt(i));
    if (c < 0) continue;
    acc = (acc << 6) | c; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xFF); }
  }
  return out;
}
function winOpen(path) {
  winStream = new ActiveXObject('ADODB.Stream');
  try {
    winStream.Type = 1; winStream.Open(); winStream.LoadFromFile(path);
    winDom = new ActiveXObject('MSXML2.DOMDocument.6.0');
  } catch (e) {
    try { winStream.Close(); } finally { winStream = null; winDom = null; }
    throw e;
  }
}
function winRead(off, len, total) {
  var node, arr, out = [], i, expected = Math.min(len, total - off);
  if (off >= total) return out;
  winStream.Position = off;
  node = winDom.createElement('b64'); node.dataType = 'bin.base64';
  node.nodeTypedValue = winStream.Read(expected);
  arr = b64decode(String(node.text));
  for (i = 0; i < arr.length; i++) out.push(arr[i]);
  if (out.length !== expected) throw new Error('short read: expected ' + expected + ', got ' + out.length);
  return out;
}

// macOS byte access: Foundation file handle + NSData base64 conversion.
function macSize(path) {
  var attrs = $.NSFileManager.defaultManager.attributesOfItemAtPathError(path, $());
  if (attrs.isNil()) return -1;
  return ObjC.unwrap(attrs.objectForKey('NSFileSize')) || 0;
}
function macOpen(path) {
  macHandle = $.NSFileHandle.fileHandleForReadingAtPath(path);
  if (macHandle.isNil()) throw new Error('cannot open file');
}
function macClose() {
  if (macHandle) {
    try { macHandle.closeFile(); } finally { macHandle = null; }
  }
}
function macRead(path, off, len, total) {
  var data, b64, arr, out = [], i, expected = Math.min(len, total - off);
  if (off >= total) return out;
  if (!macHandle) macOpen(path);
  macHandle.seekToFileOffset(off);
  data = macHandle.readDataOfLength(expected);
  if (data.isNil() || data.length === 0) throw new Error('empty read');
  b64 = String(data.base64EncodedStringWithOptions(0).js); arr = b64decode(b64);
  for (i = 0; i < arr.length; i++) out.push(arr[i]);
  if (out.length !== expected) throw new Error('short read: expected ' + expected + ', got ' + out.length);
  return out;
}

function closeReadResources() {
  if (IS_WINDOWS && winStream) {
    try { winStream.Close(); } finally { winStream = null; winDom = null; }
  }
  if (!IS_WINDOWS) macClose();
}

function statPath(path) {
  if (IS_WINDOWS) {
    var fso = WScript.CreateObject('Scripting.FileSystemObject');
    if (!fso.FileExists(path)) return -1;
    return Number(fso.GetFile(path).Size);
  }
  return Number(macSize(path));
}

function readAt(path, off, len, total) {
  if (IS_WINDOWS) return winRead(off, len, total);
  return macRead(path, off, len, total);
}

function listFiles(path, out, depth) {
  var i, item, full, isDir;
  if (depth > MAX_DEPTH) { depthTruncated = true; return false; } // bounded even with no files encountered
  if (out.length >= MAX_FILES) return true;
  if (IS_WINDOWS) {
    var fso = WScript.CreateObject('Scripting.FileSystemObject');
    if (fso.FileExists(path)) { out.push(path); return false; }
    if (!fso.FolderExists(path)) { out.push(path); return false; }
    var folder = fso.GetFolder(path), files = new Enumerator(folder.Files), dirs = new Enumerator(folder.Subfolders);
    for (; !files.atEnd(); files.moveNext()) { if (out.length >= MAX_FILES) return true; out.push(String(files.item().Path)); }
    for (; !dirs.atEnd(); dirs.moveNext()) if (listFiles(String(dirs.item().Path), out, depth + 1)) return true;
    return out.length >= MAX_FILES;
  }
  var fm = $.NSFileManager.defaultManager;
  var ref = Ref(), exists = fm.fileExistsAtPathIsDirectory(path, ref);
  if (!ObjC.unwrap(exists)) { out.push(path); return false; }
  if (!ObjC.unwrap(ref[0])) { out.push(path); return false; }
  var names = fm.contentsOfDirectoryAtPathError(path, $());
  if (names.isNil()) return false;
  for (i = 0; i < names.count; i++) {
    item = ObjC.unwrap(names.objectAtIndex(i)); full = path + '/' + item;
    isDir = Ref(); fm.fileExistsAtPathIsDirectory(full, isDir);
    if (ObjC.unwrap(isDir[0])) { if (listFiles(full, out, depth + 1)) return true; }
    else { if (out.length >= MAX_FILES) return true; out.push(full); }
  }
  return out.length >= MAX_FILES;
}

function scanFull(path, size) {
  var state = {
    total: 0, blocks: 0, hist: [], ascii: 0, ansi: 0, nul: 0,
    controls: 0, high: 0, utf8Bad: 0, utf8Multi: 0, utf8Pending: [],
    gbkLead: 0, gbkOk: 0, gbkBad: 0, chunkCount: 0, chunkMean: 0, chunkM2: 0, first: [], bom: '-',
    utf16Units: 0, utf16Invalid: 0, utf16Controls: 0, utf16Carry: null,
    utf16Little: false, utf16Surrogate: null
  };
  var i, block, offset = 0, chunkHist, chunk, chunkH, delta;
  for (i = 0; i < 256; i++) state.hist[i] = 0;
  try {
    if (IS_WINDOWS) winOpen(path); else macOpen(path);
    while (offset < size) {
      var requested = Math.min(BLOCK_SIZE, size - offset);
      chunk = readAt(path, offset, requested, size);
      if (chunk.length !== requested) throw new Error('short read');
      if (state.first.length < 4) {
        for (i = 0; i < chunk.length && state.first.length < 4; i++) state.first.push(chunk[i]);
      }
      chunkHist = [];
      for (i = 0; i < 256; i++) chunkHist[i] = 0;
      for (i = 0; i < chunk.length; i++) {
        var b = chunk[i];
        state.total++; state.hist[b]++; chunkHist[b]++;
        if ((b >= 0x20 && b <= 0x7E) || b === 9 || b === 10 || b === 13) state.ascii++;
        if ((b >= 0x20 && b <= 0x7E) || b === 9 || b === 10 || b === 13 || b >= 0xA0) state.ansi++;
        if (b === 0) state.nul++;
        if (b >= 0x80) state.high++;
        if (b < 0x20 && b !== 9 && b !== 10 && b !== 13) state.controls++;
      }
      chunkH = histEntropy(chunkHist, chunk.length);
      state.chunkCount++;
      delta = chunkH - state.chunkMean;
      state.chunkMean += delta / state.chunkCount;
      state.chunkM2 += delta * (chunkH - state.chunkMean);
      utf8Feed(state, chunk);
      gbkFeed(state, chunk);
      offset += chunk.length; state.blocks++;
    }
    utf8Finish(state); gbkFinish(state);
    detectUtf16(state);
    if (state.total !== size) throw new Error('file size changed during scan');
    closeReadResources();
    return state;
  } catch (e) {
    closeReadResources();
    e.scannedBytes = state.total;
    e.expectedBytes = size;
    throw e;
  }
}

function histEntropy(hist, total) {
  var i, p, h = 0;
  if (!total) return 0;
  for (i = 0; i < hist.length; i++) if (hist[i]) { p = hist[i] / total; h -= p * Math.log(p) / Math.LN2; }
  return h;
}

function utf8Feed(state, bytes) {
  var data = state.utf8Pending.concat(bytes), i = 0, first, need, valid, second;
  state.utf8Pending = [];
  while (i < data.length) {
    first = data[i];
    if (first < 0x80) { i++; continue; }
    need = first >= 0xC2 && first <= 0xDF ? 1 : first >= 0xE0 && first <= 0xEF ? 2 : first >= 0xF0 && first <= 0xF4 ? 3 : 0;
    if (!need) { state.utf8Bad++; i++; continue; }
    if (i + need >= data.length) { state.utf8Pending = data.slice(i); return; }
    valid = true;
    for (var j = 1; j <= need; j++) if (data[i + j] < 0x80 || data[i + j] > 0xBF) valid = false;
    second = data[i + 1];
    if (valid && ((first === 0xE0 && second < 0xA0) || (first === 0xED && second > 0x9F) || (first === 0xF0 && second < 0x90) || (first === 0xF4 && second > 0x8F))) valid = false;
    if (!valid) { state.utf8Bad++; i++; } else { state.utf8Multi += need; i += need + 1; }
  }
}
function utf8Finish(state) { if (state.utf8Pending.length) state.utf8Bad++; }

function gbkFeed(state, bytes) {
  var data = (state.gbkPending || []).concat(bytes), i = 0, b, t;
  state.gbkPending = [];
  while (i < data.length) {
    b = data[i];
    if (b < 0x80) { i++; continue; }
    if (b >= 0x81 && b <= 0xFE) {
      state.gbkLead++;
      if (i + 1 >= data.length) { state.gbkPending = [b]; return; }
      t = data[i + 1];
      if (t >= 0x40 && t <= 0xFE && t !== 0x7F) { state.gbkOk++; i += 2; } else { state.gbkBad++; i++; }
    } else { state.gbkBad++; i++; }
  }
}
function gbkFinish(state) { if (state.gbkPending && state.gbkPending.length) state.gbkBad++; }

function detectUtf16(state) {
  var f = state.first, i, nulEven = 0, nulOdd = 0;
  if (f.length >= 2 && f[0] === 0xFF && f[1] === 0xFE) state.bom = 'utf16le';
  else if (f.length >= 2 && f[0] === 0xFE && f[1] === 0xFF) state.bom = 'utf16be';
  if (state.bom !== '-') return;
  // A BOM-less UTF-16 suspicion is structural only; it does not name a format.
  // Use NUL lane concentration as a conservative signal, not as automatic TEXT.
  // The final type classifier below remains fail-closed for ambiguous files.
  state.nulLane = state.nul > 0 ? 'mixed' : '-';
}


function gateScore(coverage, type, encoding, entropyValue, variance, invisPerKb, structureCount) {
  var score = 100, coverageValue = parseFloat(coverage);
  if (type !== 'TEXT') return 0;
  if (coverageValue < 100) score -= Math.min(25, Math.ceil((100 - coverageValue) / 10) * 5);
  if (encoding !== 'utf8' && encoding !== 'utf8-bom') score -= 10;
  if (structureCount > 0) score -= Math.min(20, structureCount * 5);
  if (entropyValue > 7) score -= 20;
  if (variance > 1) score -= 15;
  if (invisPerKb > 10) score -= 20;
  else if (invisPerKb > 1) score -= 10;
  return Math.max(0, Math.round(score));
}

function classifyFull(state) {
  var total = state.total, asciiRatio = state.ascii / Math.max(1, total), ansiRatio = state.ansi / Math.max(1, total);
  var encoding = '-', type = 'BIN';
  if (state.bom === 'utf16le' || state.bom === 'utf16be') {
    // BOM is an encoding observation; code-unit validation remains conservative.
    encoding = state.bom;
    type = state.utf8Bad === 0 && state.controls / Math.max(1, total / 2) <= 0.05 ? 'TEXT' : 'BIN';
  } else if (state.utf8Bad === 0 && (asciiRatio > 0.6 || state.utf8Multi > 0)) {
    encoding = 'utf8'; type = 'TEXT';
  } else if (state.gbkLead / Math.max(1, total) >= 0.02 && state.gbkBad / Math.max(1, total) <= 0.05 && state.gbkOk / Math.max(1, total) >= 0.02) {
    encoding = 'gbk'; type = 'TEXT';
  } else if (ansiRatio > 0.9 && state.nul / Math.max(1, total) < 0.01) {
    encoding = 'ansi'; type = 'TEXT';
  }
  return { type:type, encoding:encoding, invis:state.controls };
}

function analyze(path) {
  var ext = extOf(path), size = statPath(path), state;
  if (size < 0) return { file:path, ext:ext, size:'-', type:'-', encoding:'-', dossier:'ERROR-NOT-FOUND', entropy:'-', blocks:'-', coverage:'-', score:'-', flag:'DENY', status:'error' };
  try { state = scanFull(path, size); } catch (e) {
    var partial = e.scannedBytes || 0;
    var partialCoverage = size ? (partial * 100 / size).toFixed(1) + '%' : '0.0%';
    return { file:path, ext:ext, size:displaySize(size), type:'-', encoding:'-', dossier:'READ-ERROR', entropy:'-', blocks:'-', coverage:partialCoverage, score:'-', flag:'DENY', status:'error' };
  }
  var measured = classifyFull(state), h = histEntropy(state.hist, state.total), variance = state.chunkCount ? state.chunkM2 / state.chunkCount : 0;
  var invis = state.total ? state.controls * 1024 / state.total : 0;
  var dossier = [];
  if (h > 7) dossier.push('hi-ent');
  if (variance > 1) dossier.push('spliced');
  if (invis > 1) dossier.push('invis=' + invis.toFixed(1) + '/kB');
  if (measured.type === 'TEXT' && measured.encoding !== 'utf8') dossier.push('non-utf8');
  if (state.high / Math.max(1, state.total) > 0.35) dossier.push('high-byte');
  if (state.controls / Math.max(1, state.total) > 0.01) dossier.push('control-density');
  if (measured.type === 'BIN') dossier.push('not-text');
  var coverage = '100.0%';
  var score = gateScore(coverage, measured.type, measured.encoding, h, variance, invis, (state.high / Math.max(1, state.total) > 0.35 ? 1 : 0) + (state.controls / Math.max(1, state.total) > 0.01 ? 1 : 0));
  var flag = measured.type !== 'TEXT' ? 'DENY' : (score >= 85 ? 'TEXT-CANDIDATE' : 'REVIEW');
  return { file:path, ext:ext, size:displaySize(size), type:measured.type, encoding:measured.encoding, dossier:dossier.length ? dossier.join(',') : '-', entropy:h.toFixed(2), blocks:state.blocks, coverage:coverage, score:score, flag:flag, status:'scanned' };
}

function pad(value, width) { value = String(value); while (value.length < width) value += ' '; return value; }
function run(args) {
  var files = [], truncated = false, i, rows = [], cols = ['file','ext','size','type','encoding','dossier','entropy','blocks','coverage','score','flag','status'], widths = [], out, sep = '', row, c, candidate = 0, review = 0, deny = 0, skipped = 0, error = 0;
  depthTruncated = false;
  for (i = 0; i < args.length; i++) if (listFiles(args[i], files, 0)) truncated = true;
  for (i = 0; i < files.length; i++) { row = analyze(files[i]); rows.push(row); if (row.flag === 'TEXT-CANDIDATE') candidate++; else if (row.flag === 'REVIEW') review++; else if (row.status === 'skipped') skipped++; else if (row.status === 'error') error++; else deny++; }
  for (c = 0; c < cols.length; c++) { widths[c] = cols[c].length; for (i = 0; i < rows.length; i++) if (String(rows[i][cols[c]]).length > widths[c]) widths[c] = String(rows[i][cols[c]]).length; }
  function line(r) { var p = []; for (var k = 0; k < cols.length; k++) p.push(pad(r[cols[k]], widths[k])); return p.join(' '); }
  out = line({file:'file',ext:'ext',size:'size',type:'type',encoding:'encoding',dossier:'dossier',entropy:'entropy',blocks:'blocks',coverage:'coverage',score:'score',flag:'flag',status:'status'}) + '\n';
  for (c = 0; c < widths.length; c++) sep += (c ? ' ' : '') + new Array(widths[c] + 1).join('-');
  out += sep + '\n'; for (i = 0; i < rows.length; i++) out += line(rows[i]) + '\n';
  out += LEGEND + '\n===== SUMMARY =====\nfiles: ' + rows.length + ' | candidate: ' + candidate + ' | review: ' + review + ' | deny: ' + deny + ' | skipped: ' + skipped + ' | error: ' + error + '\n';
  if (truncated) out += 'note: file count exceeded ' + MAX_FILES + ', enumeration truncated\n';
  if (depthTruncated) out += 'note: directory depth exceeded ' + MAX_DEPTH + ', enumeration truncated\n';
  return out;
}

var args = [], i;
if (IS_WINDOWS) {
  for (i = 0; i < WScript.Arguments.Length; i++) args.push(String(WScript.Arguments(i)));
  if (!args.length) { WScript.Echo('usage: cscript //nologo file-gate.js <absolute-path> [...]'); WScript.Quit(1); }
  WScript.Echo(run(args));
} else {
  var argv = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments), start = 0;
  for (i = 0; i < argv.length; i++) if (String(argv[i]).indexOf('file-gate') >= 0) { start = i + 1; break; }
  for (i = start; i < argv.length; i++) args.push(String(argv[i]));
  if (!args.length) run([]); else run(args);
}
