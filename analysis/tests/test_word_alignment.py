import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from align_predictions import align, unique_matches


class WordAlignmentTest(unittest.TestCase):
    def test_only_unambiguous_exact_matches_are_kept(self):
        self.assertEqual(unique_matches(["we", "we", "go"], ["we", "go"]), [None, None, 1])
        self.assertEqual(unique_matches(["we", "go"], ["we", "we", "go"]), [None, 2])
        self.assertEqual(unique_matches(["they", "go"], ["we", "go"]), [None, 1])

    def test_unresolved_events_stay_in_predictions(self):
        reference = {"rulesSha256": "rules", "clips": [{
            "clipId": "clip", "audioSha256": "audio",
            "words": [{"word": "we", "phones": ["W", "IY1"]}, {"word": "go", "phones": ["G", "OW1"]}],
        }]}
        predictions = {"rulesSha256": "rules", "clips": [{
            "clipId": "clip", "audioSha256": "audio",
            "words": [{"word": "well", "phones": ["W", "EH1", "L"]}, *reference["clips"][0]["words"]],
            "errors": [
                {"wordIndex": 2, "phoneIndex": 1, "kind": "substitution", "target": "OW1"},
                {"wordIndex": 0, "phoneIndex": 1, "kind": "substitution", "target": "EH1"},
                {"wordIndex": 2, "phoneIndex": 1, "kind": "substitution", "target": "AO1"},
                {"wordIndex": 1, "phoneIndex": 2, "kind": "addition", "target": "∅"},
            ],
        }]}
        output, audit = align(reference, predictions)
        self.assertEqual([item["wordIndex"] for item in output["clips"][0]["errors"]], [1, None, None, 0])
        self.assertEqual([item["reason"] for item in audit["clips"][0]["events"]],
                         ["matched", "unmapped-asr-word", "incompatible-canonical-phone-index", "matched"])
        predictions["clips"][0]["audioSha256"] = "other"
        with self.assertRaisesRegex(ValueError, "same audio digest"):
            align(reference, predictions)
