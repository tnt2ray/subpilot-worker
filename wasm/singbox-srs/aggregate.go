// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
)

type aggregationRule struct {
	Type               string `json:"type"`
	Value              string `json:"value"`
	Raw                string `json:"raw"`
	NormalizedKey      string `json:"normalizedKey"`
	Label              string `json:"label"`
	ClashDomainPattern string `json:"clashDomainPattern,omitempty"`
	ASNExpansionKey    string `json:"asnExpansionKey,omitempty"`
}

type compiledRule struct {
	Type               string `json:"type"`
	Value              string `json:"value"`
	Raw                string `json:"raw"`
	ClashDomainPattern string `json:"clashDomainPattern,omitempty"`
}

type aggregationBuckets struct {
	Domain    []compiledRule `json:"domain"`
	IPCIDR    []compiledRule `json:"ipcidr"`
	Classical []compiledRule `json:"classical"`
}

type aggregationInput struct {
	Operation     string                       `json:"operation"`
	Version       int                          `json:"version"`
	Target        string                       `json:"target,omitempty"`
	Rules         []aggregationRule            `json:"rules"`
	ASNExpansions map[string][]aggregationRule `json:"asnExpansions,omitempty"`
}

type aggregationOutput struct {
	Version        int                `json:"version"`
	Buckets        aggregationBuckets `json:"buckets"`
	DuplicateCount int                `json:"duplicateCount"`
	Warnings       []string           `json:"warnings"`
}

func aggregate(source []byte) error {
	var input aggregationInput
	if err := json.Unmarshal(source, &input); err != nil {
		return err
	}
	if input.Operation != "aggregate" || input.Version != 1 || input.Rules == nil {
		return errors.New("invalid aggregation request")
	}
	if input.Target != "" && input.Target != "surge" && input.Target != "clash" && input.Target != "sing-box" {
		return errors.New("invalid aggregation target")
	}
	output := aggregationOutput{
		Version: 1,
		Buckets: aggregationBuckets{
			Domain: []compiledRule{}, IPCIDR: []compiledRule{}, Classical: []compiledRule{},
		},
		Warnings: []string{},
	}
	seen := make(map[string]struct{})
	suffixes := make(map[string]struct{})
	accept := func(rule aggregationRule) error {
		if !validAggregationRule(rule) || rule.ASNExpansionKey != "" {
			return errors.New("invalid aggregation rule")
		}
		if _, duplicate := seen[rule.NormalizedKey]; duplicate {
			output.DuplicateCount++
			return nil
		}
		seen[rule.NormalizedKey] = struct{}{}
		if rule.Type == "DOMAIN" {
			for suffix := normalizedDomain(rule.Value); suffix != ""; {
				if _, covered := suffixes[suffix]; covered {
					output.Warnings = append(output.Warnings, rule.Label+" DOMAIN,"+rule.Value+" 可能已被前面的 DOMAIN-SUFFIX 覆盖。")
					break
				}
				dot := strings.IndexByte(suffix, '.')
				if dot < 0 {
					break
				}
				suffix = suffix[dot+1:]
			}
		}
		if rule.Type == "DOMAIN-SUFFIX" {
			suffixes[normalizedDomain(rule.Value)] = struct{}{}
		}
		compiled := compiledRule{Type: rule.Type, Value: rule.Value, Raw: rule.Raw, ClashDomainPattern: rule.ClashDomainPattern}
		switch aggregationBucket(rule) {
		case "domain":
			output.Buckets.Domain = append(output.Buckets.Domain, compiled)
		case "ipcidr":
			output.Buckets.IPCIDR = append(output.Buckets.IPCIDR, compiled)
		default:
			output.Buckets.Classical = append(output.Buckets.Classical, compiled)
		}
		return nil
	}

	// ASN rules have their own deduplication index. Their expansions follow all
	// ordinary source and inline rules, preserving the existing compiler order.
	seenASN := make(map[string]struct{})
	var expansionKeys []string
	for _, rule := range input.Rules {
		if !validAggregationRule(rule) {
			return errors.New("invalid aggregation rule")
		}
		if rule.ASNExpansionKey != "" {
			if input.Target != "sing-box" || rule.Type != "IP-ASN" {
				return errors.New("invalid ASN expansion rule")
			}
			if _, duplicate := seenASN[rule.NormalizedKey]; duplicate {
				output.DuplicateCount++
				continue
			}
			if _, exists := input.ASNExpansions[rule.ASNExpansionKey]; !exists {
				return errors.New("missing ASN expansion")
			}
			seenASN[rule.NormalizedKey] = struct{}{}
			expansionKeys = append(expansionKeys, rule.ASNExpansionKey)
			continue
		}
		if err := accept(rule); err != nil {
			return err
		}
	}
	for _, key := range expansionKeys {
		for _, rule := range input.ASNExpansions[key] {
			if err := accept(rule); err != nil {
				return err
			}
		}
	}

	if input.Target == "" || input.Target == "surge" {
		for _, rule := range output.Buckets.Classical {
			if rule.Type != "DOMAIN" && rule.Type != "DOMAIN-SUFFIX" && rule.Type != "DOMAIN-KEYWORD" {
				continue
			}
			parts := splitRuleLine(rule.Raw)
			for index := 2; index < len(parts); index++ {
				if strings.ToLower(parts[index]) == "extended-matching" {
					output.Buckets.Classical = append(output.Buckets.Domain, output.Buckets.Classical...)
					output.Buckets.Domain = []compiledRule{}
					return writeAggregation(output)
				}
			}
		}
	}
	return writeAggregation(output)
}

func writeAggregation(output aggregationOutput) error {
	encoded, err := json.Marshal(output)
	if err != nil {
		return err
	}
	if len(encoded)+1 > aggregationLimit {
		return errors.New("aggregation output exceeds size limit")
	}
	_, err = os.Stdout.Write(append(encoded, '\n'))
	return err
}

func validAggregationRule(rule aggregationRule) bool {
	return rule.Type != "" && rule.Value != "" && rule.Raw != "" && rule.NormalizedKey != ""
}

func aggregationBucket(rule aggregationRule) string {
	// Clash domain-provider patterns stay in the domain bucket even when their
	// equivalent generic rule is DOMAIN-REGEX. All other rules follow the parser.
	if rule.ClashDomainPattern != "" {
		return "domain"
	}
	if len(splitRuleLine(rule.Raw)) > 2 {
		return "classical"
	}
	switch rule.Type {
	case "DOMAIN", "DOMAIN-SUFFIX":
		return "domain"
	case "IP-CIDR", "IP-CIDR6":
		return "ipcidr"
	default:
		return "classical"
	}
}

func normalizedDomain(value string) string {
	value = trimRuleSpace(value)
	for _, prefix := range []string{"+.", "*.", "."} {
		value = strings.TrimPrefix(value, prefix)
	}
	return strings.ToLower(strings.TrimSuffix(value, "."))
}

// Keep commas inside quoted values and logical-rule parentheses intact, using
// the same splitting rules as the shared TypeScript parser.
func splitRuleLine(line string) []string {
	var parts []string
	var current strings.Builder
	depth := 0
	var quote byte
	escaped := false
	for index := 0; index < len(line); index++ {
		character := line[index]
		if escaped {
			current.WriteByte(character)
			escaped = false
			continue
		}
		if character == '\\' && quote != 0 {
			current.WriteByte(character)
			escaped = true
			continue
		}
		if quote != 0 {
			current.WriteByte(character)
			if character == quote {
				if index+1 < len(line) && line[index+1] == quote {
					current.WriteByte(line[index+1])
					index++
				} else {
					quote = 0
				}
			}
			continue
		}
		if character == '\'' || character == '"' {
			quote = character
			current.WriteByte(character)
			continue
		}
		if character == '(' {
			depth++
		}
		if character == ')' && depth > 0 {
			depth--
		}
		if character == ',' && depth == 0 {
			parts = append(parts, trimRuleSpace(current.String()))
			current.Reset()
			continue
		}
		current.WriteByte(character)
	}
	last := trimRuleSpace(current.String())
	if last != "" || len(parts) > 0 {
		parts = append(parts, last)
	}
	return parts
}

func trimRuleSpace(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		return character >= '\t' && character <= '\r' || character == ' ' || character == '\u00a0' || character == '\u1680' ||
			character >= '\u2000' && character <= '\u200a' || character == '\u2028' || character == '\u2029' ||
			character == '\u202f' || character == '\u205f' || character == '\u3000' || character == '\ufeff'
	})
}
