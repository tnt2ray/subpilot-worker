// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
)

type headlessFieldGroup struct {
	field  string
	values []json.RawMessage
	seen   map[headlessPrimitive]struct{}
}

type headlessPrimitive struct {
	kind   byte
	text   string
	number float64
	truth  bool
}

// Single-field arrays share OR semantics and can be merged. Keep field and
// value order stable, then append rules with multiple fields in their order.
func mergeHeadlessRules(source []byte) ([]byte, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(source, &document); err != nil {
		return nil, err
	}
	encodedRules, exists := document["rules"]
	if !exists {
		return source, nil
	}
	var rules []json.RawMessage
	if err := json.Unmarshal(encodedRules, &rules); err != nil {
		return nil, err
	}
	var groups []headlessFieldGroup
	groupIndexes := make(map[string]int)
	remaining := []json.RawMessage{}
	for _, encodedRule := range rules {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encodedRule, &fields); err != nil {
			return nil, err
		}
		if len(fields) != 1 {
			remaining = append(remaining, encodedRule)
			continue
		}
		for field, value := range fields {
			// A RawMessage contains exactly its JSON value, with no leading space.
			if len(value) == 0 || value[0] != '[' {
				remaining = append(remaining, encodedRule)
				continue
			}
			var values []json.RawMessage
			if err := json.Unmarshal(value, &values); err != nil {
				return nil, err
			}
			index, found := groupIndexes[field]
			if !found {
				index = len(groups)
				groupIndexes[field] = index
				groups = append(groups, headlessFieldGroup{field: field, values: []json.RawMessage{}, seen: make(map[headlessPrimitive]struct{})})
			}
			group := &groups[index]
			for _, value := range values {
				key, primitive, err := headlessValueKey(value)
				if err != nil {
					return nil, err
				}
				if primitive {
					if _, duplicate := group.seen[key]; duplicate {
						continue
					}
					group.seen[key] = struct{}{}
				}
				group.values = append(group.values, value)
			}
		}
	}
	merged := make([]json.RawMessage, 0, len(groups)+len(remaining))
	for _, group := range groups {
		encoded, err := json.Marshal(map[string][]json.RawMessage{group.field: group.values})
		if err != nil {
			return nil, err
		}
		merged = append(merged, encoded)
	}
	merged = append(merged, remaining...)
	var err error
	document["rules"], err = json.Marshal(merged)
	if err != nil {
		return nil, err
	}
	return json.Marshal(document)
}

// Match JavaScript Set equality for JSON primitives. Objects and arrays are
// separate parsed values, so identical JSON text does not make them duplicates.
func headlessValueKey(encoded json.RawMessage) (headlessPrimitive, bool, error) {
	var value any
	if err := json.Unmarshal(encoded, &value); err != nil {
		return headlessPrimitive{}, false, err
	}
	switch value := value.(type) {
	case nil:
		return headlessPrimitive{kind: '0'}, true, nil
	case string:
		return headlessPrimitive{kind: 's', text: value}, true, nil
	case float64:
		return headlessPrimitive{kind: 'n', number: value}, true, nil
	case bool:
		return headlessPrimitive{kind: 'b', truth: value}, true, nil
	default:
		return headlessPrimitive{}, false, nil
	}
}
