// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	stdjson "encoding/json"
	"errors"
	"io"
	"os"

	"github.com/sagernet/sing-box/common/srs"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
)

const sourceLimit = 16 * 1024 * 1024
const aggregationLimit = 8 * 1024 * 1024

func main() {
	if err := compile(); err != nil {
		// Never include rule contents in runtime diagnostics.
		os.Exit(1)
	}
}

func compile() error {
	source, err := io.ReadAll(io.LimitReader(os.Stdin, sourceLimit+1))
	if err != nil {
		return err
	}
	if len(source) > sourceLimit {
		os.Exit(2)
	}
	var envelope struct {
		Operation string `json:"operation"`
	}
	if err := stdjson.Unmarshal(source, &envelope); err != nil {
		return err
	}
	if envelope.Operation == "aggregate" {
		if len(source) > aggregationLimit {
			os.Exit(2)
		}
		return aggregate(source)
	}
	if envelope.Operation != "" {
		return errors.New("unsupported compiler operation")
	}
	source, err = mergeHeadlessRules(source)
	if err != nil {
		return err
	}
	ruleSet, err := json.UnmarshalExtended[option.PlainRuleSetCompat](source)
	if err != nil {
		return err
	}
	return srs.Write(os.Stdout, ruleSet.Options, downgradeVersion(ruleSet.Version, ruleSet.Options.Rules))
}

// This matches cmd/sing-box/cmd_rule_set_compile.go in the pinned release.
// Importing its command package would also link the entire proxy application.
func downgradeVersion(version uint8, rules []option.HeadlessRule) uint8 {
	if version == C.RuleSetVersion5 && !anyRule(rules, func(rule option.DefaultHeadlessRule) bool {
		return len(rule.PackageNameRegex) > 0
	}) {
		version = C.RuleSetVersion4
	}
	if version == C.RuleSetVersion4 && !anyRule(rules, func(rule option.DefaultHeadlessRule) bool {
		return rule.NetworkInterfaceAddress != nil && rule.NetworkInterfaceAddress.Size() > 0 || len(rule.DefaultInterfaceAddress) > 0
	}) {
		version = C.RuleSetVersion3
	}
	if version == C.RuleSetVersion3 && !anyRule(rules, func(rule option.DefaultHeadlessRule) bool {
		return len(rule.NetworkType) > 0 || rule.NetworkIsExpensive || rule.NetworkIsConstrained
	}) {
		version = C.RuleSetVersion2
	}
	return version
}

func anyRule(rules []option.HeadlessRule, predicate func(option.DefaultHeadlessRule) bool) bool {
	for _, rule := range rules {
		switch rule.Type {
		case C.RuleTypeDefault, "":
			if predicate(rule.DefaultOptions) {
				return true
			}
		case C.RuleTypeLogical:
			if anyRule(rule.LogicalOptions.Rules, predicate) {
				return true
			}
		}
	}
	return false
}
