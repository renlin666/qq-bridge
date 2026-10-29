"""Offline UI authorization regressions. Never contacts Docker, X11 or QQ."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('friend_ui',pathlib.Path(__file__).parent/'cloud/friend-ui.py')
worker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class Row:
 width=658
 height=68
 def crop(self,box):return self

class FriendTargetTests(unittest.TestCase):
 def test_approval_requires_current_configured_owner(self):
  with tempfile.TemporaryDirectory() as directory,patch.object(worker,'STACK',pathlib.Path(directory)):
   root=pathlib.Path(directory);(root/'state').mkdir()
   (root/'config.json').write_text(json.dumps({'ownerQQ':'123456'}))
   (root/'state/friend-requests.json').write_text(json.dumps({'requests':[{'id':'a'*16,'status':'dispatching','approvedBy':'234567','approvalKey':'private:234567','approvalMessageId':'1'}]}))
   with self.assertRaisesRegex(ValueError,'missing private administrator approval'):worker.approval('a'*16)
   (root/'config.json').write_text(json.dumps({'ownerQQ':''}))
   with self.assertRaisesRegex(ValueError,'invalid administrator'):worker.approval('a'*16)

 def check_row(self,text,buttons=None):
  with patch.object(worker,'ocr',return_value=text),patch.object(worker,'words',return_value=buttons if buttons is not None else [('添加',607,33)]):
   return worker.result_button(Row(),'123456789')

 def test_complete_field_matches(self):
  for text in ['昵称(123456789)\n21岁 添加','昵称（ 123456789 ） 添加','QQ:123456789 添加','QQ：123456789 添加']:
   with self.subTest(text=text):self.assertEqual(self.check_row(text),(607,33))

 def test_wrong_or_ambiguous_identity_stops(self):
  for text in ['昵称(1234567890) 添加','昵称(9123456789) 添加','QQ:1234567890 添加',
   '昵称(12345 6789) 添加','昵称12345 QQ:6789 添加','昵称123456789 添加',
   '(123456789) (987654321) 添加','(123456789) (123456789) 添加','QQ:0123456789 添加']:
   with self.subTest(text=text):self.assertIsNone(self.check_row(text))

 def test_button_must_be_unique_and_inside_the_result_row(self):
  for buttons in [[],[('已添加',607,33)],[('添加',30,33)],[('添加',607,75)],
   [('添加',600,30),('添加',620,35)]]:
   with self.subTest(buttons=buttons):self.assertIsNone(self.check_row('昵称(123456789)',buttons))

 def test_target_change_after_search_does_not_click_or_reserve(self):
  with tempfile.TemporaryDirectory() as directory,patch.object(worker,'DATA',pathlib.Path(directory)),\
   patch.object(worker,'approval',return_value={'targetUserId':'123456789'}),\
   patch.object(worker,'is_friend',return_value=False),\
   patch.object(worker,'search',return_value=({'x':0,'y':0},Row(),(607,33))),\
   patch.object(worker,'frame',return_value=Row()),\
   patch.object(worker,'ocr',return_value='昵称(1234567890) 添加'),\
   patch.object(worker,'click') as click:
   with self.assertRaisesRegex(ValueError,'已变化'):worker.perform('a'*16)
   click.assert_not_called()
   self.assertEqual(list(pathlib.Path(directory).iterdir()),[])

if __name__=='__main__':unittest.main()
