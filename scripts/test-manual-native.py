"""Regression checks for PDF caption/body separation. No source PDF is modified."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import pymupdf as fitz

spec = importlib.util.spec_from_file_location('manuals', Path(__file__).with_name('build-manuals.py'))
manuals = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manuals)


class NativeTextLayout(unittest.TestCase):
    def page(self, text):
        document = fitz.open()
        page = document.new_page()
        page.insert_text((30, 50), text, fontsize=10)
        self.addCleanup(document.close)
        return page

    def test_caption_padding_does_not_swallow_body_text(self):
        page = self.page('Caption                         Body text')
        lines = manuals.native_lines(page, separate_labels=True)
        self.assertEqual([line['text'] for line in lines], ['Caption', 'Body text'])
        crop = lines[0]['box'] + (-1, -1, 1, 1)
        self.assertTrue(manuals.picture_line(lines[0], [crop]))
        self.assertFalse(manuals.picture_line(lines[1], [crop]))

    def test_word_spaces_and_indented_list_markers_are_retained(self):
        text = 'To toggle between 12-hour and 24-hour timekeeping'
        self.assertEqual(manuals.native_lines(self.page(text), True)[0]['text'], text)
        lines = manuals.native_lines(self.page('1.                         First step'), True)
        self.assertEqual([line['text'] for line in lines], ['1. First step'])

    def test_repaired_cyrillic_caption_fits_and_stays_inside_its_diagram(self):
        page = self.page('Original body text')
        repair = dict(box=[30, 60, 180, 85], text='День недели', fontSize=9)
        record = {'pages': {'1': {'figureLabelRepairs': [repair]}}}
        with patch.dict(manuals.PROOFREADING, {'test-ru': record}):
            manuals.correct_figure_text(page, 'test-ru', 1, [fitz.Rect(20, 55, 200, 100)])
            self.assertIn('День недели', page.get_text())
            with self.assertRaisesRegex(ValueError, 'outside its illustration'):
                manuals.correct_figure_text(page, 'test-ru', 1, [fitz.Rect(40, 55, 200, 100)])


if __name__ == '__main__':
    unittest.main()
