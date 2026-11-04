package wallet

import (
	"encoding/binary"
	"fmt"
	"math"
	"time"
	"unicode/utf16"
)

// 这是一个**只够用**的 binary plist 解析器。
//
// 为什么自己写：macOS/Windows 的通知库都把通知内容存成 bplist 二进制块，
// 引一个第三方 plist 库会破坏「零依赖静态二进制」这条底线 ——
// 监控程序不该为了读一条通知而背上一整条依赖链。
//
// 覆盖范围：通知负载里实际会出现的类型（dict / array / string / int / real /
// date / bool / data）。不支持的扩展类型返回错误而不是 panic。
func parseBPlist(b []byte) (any, error) {
	if len(b) < 8+32 || string(b[:6]) != "bplist" {
		return nil, fmt.Errorf("不是 binary plist")
	}
	trailer := b[len(b)-32:]
	offsetSize := int(trailer[6])
	refSize := int(trailer[7])
	numObjects := binary.BigEndian.Uint64(trailer[8:16])
	topObject := binary.BigEndian.Uint64(trailer[16:24])
	offsetTable := binary.BigEndian.Uint64(trailer[24:32])

	if offsetSize == 0 || refSize == 0 || numObjects == 0 {
		return nil, fmt.Errorf("bplist trailer 异常")
	}
	if offsetTable+numObjects*uint64(offsetSize) > uint64(len(b)) {
		return nil, fmt.Errorf("bplist 偏移表越界")
	}

	offsets := make([]uint64, numObjects)
	for i := uint64(0); i < numObjects; i++ {
		start := int(offsetTable + i*uint64(offsetSize))
		offsets[i] = readUint(b[start:], offsetSize)
	}
	if topObject >= numObjects {
		return nil, fmt.Errorf("bplist 顶层对象越界")
	}

	p := &bplistParser{buf: b, offsets: offsets, refSize: refSize}
	return p.parse(topObject, 0)
}

type bplistParser struct {
	buf     []byte
	offsets []uint64
	refSize int
}

func (p *bplistParser) parse(idx uint64, depth int) (any, error) {
	if depth > 32 {
		return nil, fmt.Errorf("bplist 嵌套过深")
	}
	if idx >= uint64(len(p.offsets)) {
		return nil, fmt.Errorf("对象索引越界")
	}
	pos := int(p.offsets[idx])
	if pos >= len(p.buf) {
		return nil, fmt.Errorf("对象偏移越界")
	}

	marker := p.buf[pos]
	typ := marker >> 4
	info := marker & 0x0f
	pos++

	switch typ {
	case 0x0: // null / bool / fill
		switch info {
		case 0x0:
			return nil, nil
		case 0x8:
			return false, nil
		case 0x9:
			return true, nil
		}
		return nil, nil

	case 0x1: // 整数
		n := 1 << info
		if pos+n > len(p.buf) {
			return nil, fmt.Errorf("整数字节不足")
		}
		var v uint64
		for i := 0; i < n; i++ {
			v = v<<8 | uint64(p.buf[pos+i])
		}
		return int64(v), nil

	case 0x2: // 实数
		n := 1 << info
		if pos+n > len(p.buf) {
			return nil, fmt.Errorf("实数字节不足")
		}
		switch n {
		case 4:
			return float64(math.Float32frombits(binary.BigEndian.Uint32(p.buf[pos:]))), nil
		case 8:
			return math.Float64frombits(binary.BigEndian.Uint64(p.buf[pos:])), nil
		}
		return nil, fmt.Errorf("不支持的实数宽度 %d", n)

	case 0x3: // 日期：自 2001-01-01 起的秒数（float64）
		if pos+8 > len(p.buf) {
			return nil, fmt.Errorf("日期字节不足")
		}
		secs := math.Float64frombits(binary.BigEndian.Uint64(p.buf[pos:]))
		return time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC).Add(
			time.Duration(secs * float64(time.Second))), nil

	case 0x4: // 二进制数据
		length, next, err := p.length(pos, info)
		if err != nil {
			return nil, err
		}
		end := next + int(length)
		if end > len(p.buf) {
			return nil, fmt.Errorf("data 长度越界")
		}
		return p.buf[next:end], nil

	case 0x5, 0x6: // ASCII / UTF-16BE 字符串
		length, next, err := p.length(pos, info)
		if err != nil {
			return nil, err
		}
		if typ == 0x5 {
			end := next + int(length)
			if end > len(p.buf) {
				return nil, fmt.Errorf("ascii 长度越界")
			}
			return string(p.buf[next:end]), nil
		}
		end := next + int(length)*2
		if end > len(p.buf) {
			return nil, fmt.Errorf("utf16 长度越界")
		}
		u := make([]uint16, length)
		for i := 0; i < int(length); i++ {
			u[i] = binary.BigEndian.Uint16(p.buf[next+i*2:])
		}
		return string(utf16.Decode(u)), nil

	case 0xa: // 数组
		length, next, err := p.length(pos, info)
		if err != nil {
			return nil, err
		}
		out := make([]any, 0, length)
		for i := uint64(0); i < length; i++ {
			off := next + int(i)*p.refSize
			if off+p.refSize > len(p.buf) {
				return nil, fmt.Errorf("数组引用越界")
			}
			ref := readUint(p.buf[off:], p.refSize)
			v, err := p.parse(ref, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil

	case 0xd: // 字典
		length, next, err := p.length(pos, info)
		if err != nil {
			return nil, err
		}
		out := make(map[string]any, length)
		for i := uint64(0); i < length; i++ {
			kOff := next + int(i)*p.refSize
			vOff := next + int(length+i)*p.refSize
			if kOff+p.refSize > len(p.buf) || vOff+p.refSize > len(p.buf) {
				return nil, fmt.Errorf("字典引用越界")
			}
			kRef := readUint(p.buf[kOff:], p.refSize)
			vRef := readUint(p.buf[vOff:], p.refSize)
			kv, err := p.parse(kRef, depth+1)
			if err != nil {
				return nil, err
			}
			vv, err := p.parse(vRef, depth+1)
			if err != nil {
				return nil, err
			}
			key, ok := kv.(string)
			if !ok {
				continue
			}
			out[key] = vv
		}
		return out, nil
	}

	return nil, fmt.Errorf("不支持的 bplist 类型 0x%x", typ)
}

// length 解析「长度」，返回长度值与数据起始位置。
// info == 0x0f 表示长度另存为一个整数对象。
func (p *bplistParser) length(pos int, info byte) (uint64, int, error) {
	if info != 0x0f {
		return uint64(info), pos, nil
	}
	if pos >= len(p.buf) {
		return 0, 0, fmt.Errorf("长度字节不足")
	}
	m := p.buf[pos]
	if m>>4 != 0x1 {
		return 0, 0, fmt.Errorf("长度不是整数")
	}
	n := 1 << (m & 0x0f)
	pos++
	if pos+n > len(p.buf) {
		return 0, 0, fmt.Errorf("长度整数越界")
	}
	var v uint64
	for i := 0; i < n; i++ {
		v = v<<8 | uint64(p.buf[pos+i])
	}
	return v, pos + n, nil
}

func readUint(b []byte, size int) uint64 {
	var v uint64
	for i := 0; i < size && i < len(b); i++ {
		v = v<<8 | uint64(b[i])
	}
	return v
}
