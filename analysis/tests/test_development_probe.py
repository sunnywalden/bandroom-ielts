import sys
import unittest
from pathlib import Path

from bandroom_acoustic.schema import validate_events

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from event_matching import match_events
from phone_graph import Segment, word_events


def addition(start, occurrence=None):
    event = {"wordIndex": 0, "phoneIndex": 1, "kind": "addition",
             "target": "∅", "actual": "AH", "startMs": start, "endMs": start + 30}
    if occurrence is not None:
        event["gapOccurrence"] = occurrence
    return event


class RepeatedAdditionsTest(unittest.TestCase):
    def test_second_occurrence_can_match_when_the_first_was_not_detected(self):
        first, second = addition(100), addition(330, 1)
        prediction = addition(330)
        self.assertEqual(match_events([first, second], [prediction]), [(second, prediction, True)])

    def test_overlapping_window_duplicate_cannot_match_twice(self):
        first, second = addition(100), addition(270, 1)
        self.assertEqual(len(match_events([first, second], [first, addition(110, 1)])), 1)
        self.assertEqual(len(match_events([first, second], [first, second])), 2)

    def test_time_matching_maximizes_cardinality_before_minimizing_distance(self):
        first, second = addition(100), addition(170, 1)
        early, late = addition(150), addition(230, 1)
        self.assertEqual(match_events([first, second], [early, late], 70),
                         [(first, early, True), (second, late, True)])

    def test_payload_requires_distinct_ordered_occurrences_and_times(self):
        first, second = addition(100), addition(250, 1)
        self.assertEqual(validate_events([first], 400), [])
        self.assertEqual(validate_events([second, first], 400), [])
        for invalid in ([first, addition(250, 0)], [first, addition(105, 1)],
                        [addition(100, 2), second], [addition(250, 0.5)],
                        [{**second, "endMs": float("nan")}],
                        [{**second, "probability": 1.1}],
                        [{"wordIndex": 0, "phoneIndex": 1, "kind": "deletion", "target": "T",
                          "actual": "∅", "anchorMs": 200, "gapOccurrence": 0}]):
            with self.subTest(invalid=invalid):
                self.assertTrue(validate_events(invalid, 400))


class PhoneGraphTest(unittest.TestCase):
    def candidates(self, segments, variants=(), addition_budget=2):
        return word_events(("K", "T"), variants, segments, 0, None, 100, 300,
                           top_substitutions=2, top_additions=2, beam=4, addition_budget=addition_budget)

    def test_acoustic_addition_is_removed_when_it_is_a_legal_variant(self):
        segments = [Segment(100, 140, {"K": .95, "G": .05}),
                    Segment(170, 215, {"AH": .98}), Segment(250, 290, {"T": .94})]
        for variants, expected in (((), [(170, 215)]), ((("K", "AH", "T"),), [])):
            rows = self.candidates(segments, variants)
            self.assertEqual([(row["startMs"], row["endMs"]) for row in rows
                              if row["kind"] == "addition" and row["phoneIndex"] == 1
                              and row["actual"] == "AH"], expected)

    def test_deletion_anchors_the_gap(self):
        rows = self.candidates([Segment(100, 140, {"K": .99})])
        self.assertIn(220, [row["anchorMs"] for row in rows if row["kind"] == "deletion"
                            and row["target"] == "T"])

    def test_alignment_can_skip_fragments_without_spending_the_addition_budget(self):
        segments = [Segment(100, 130, {"K": .99}), Segment(140, 160, {"SIL": .99}),
                    Segment(170, 205, {"AH": .99}), Segment(210, 230, {"SIL": .99}),
                    Segment(250, 290, {"T": .94, "D": .06})]
        rows = self.candidates(segments, addition_budget=1)
        self.assertTrue(any(row["kind"] == "addition" and row["actual"] == "AH"
                            and row["phoneIndex"] == 1 for row in rows))
        rows = self.candidates(segments, addition_budget=0)
        self.assertTrue(any(row["kind"] == "substitution" and row["actual"] == "D" for row in rows))
        self.assertFalse(any(row["kind"] == "addition" for row in rows))
