import plistlib, uuid, sys

OBJ = '￼'
U = lambda: str(uuid.uuid4()).upper()

def attach_out(uuid_, name):
    return {'Type': 'ActionOutput', 'OutputUUID': uuid_, 'OutputName': name}

def token_string(parts):
    """parts: list of str | attachment dict -> WFTextTokenString"""
    s, att = '', {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            att['{%d, 1}' % len(s)] = p
            s += OBJ
    return {'Value': {'string': s, 'attachmentsByRange': att}, 'WFSerializationType': 'WFTextTokenString'}

def token_attachment(a):
    return {'Value': a, 'WFSerializationType': 'WFTextTokenAttachment'}

def auth_header(tok_att):
    return {
        'Value': {'WFDictionaryFieldValueItems': [{
            'WFItemType': 0,
            'WFKey': {'Value': {'string': 'Authorization'}, 'WFSerializationType': 'WFTextTokenString'},
            'WFValue': token_string(['Bearer ', tok_att]),
        }]},
        'WFSerializationType': 'WFDictionaryFieldValue',
    }

u_url, u_tok, u_targets, u_choice, u_folder = U(), U(), U(), U(), U()
u_rep, u_name, u_ename, u_up, u_end = U(), U(), U(), U(), U()
gid = U()

url_att = attach_out(u_url, 'Text')
tok_att = attach_out(u_tok, 'Text')
repeat_item = {'Type': 'Variable', 'VariableName': 'Repeat Item'}

actions = [
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
     'WFWorkflowActionParameters': {'UUID': u_url, 'WFTextActionText': 'https://photos.example.com'}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
     'WFWorkflowActionParameters': {'UUID': u_tok, 'WFTextActionText': 'pu_paste_your_token_here'}},
    # GET /api/targets -> list of folders the user may upload to
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
     'WFWorkflowActionParameters': {
         'UUID': u_targets, 'WFHTTPMethod': 'GET', 'ShowHeaders': True,
         'WFURL': token_string([url_att, '/api/targets']),
         'WFHTTPHeaders': auth_header(tok_att)}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.choosefromlist',
     'WFWorkflowActionParameters': {
         'UUID': u_choice, 'WFChooseFromListActionPrompt': 'Upload to which folder?',
         'WFInput': token_attachment(attach_out(u_targets, 'Contents of URL'))}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.urlencode',
     'WFWorkflowActionParameters': {
         'UUID': u_folder, 'WFEncodeMode': 'Encode',
         'WFInput': token_string([attach_out(u_choice, 'Chosen Item')])}},
    # One request per photo/video, so any number can be shared at once
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.repeat.each',
     'WFWorkflowActionParameters': {
         'UUID': u_rep, 'GroupingIdentifier': gid, 'WFControlFlowMode': 0,
         'WFInput': token_attachment({'Type': 'ExtensionInput'})}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.getitemname',
     'WFWorkflowActionParameters': {'UUID': u_name, 'WFInput': token_attachment(repeat_item)}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.urlencode',
     'WFWorkflowActionParameters': {
         'UUID': u_ename, 'WFEncodeMode': 'Encode',
         'WFInput': token_string([attach_out(u_name, 'Name')])}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
     'WFWorkflowActionParameters': {
         'UUID': u_up, 'WFHTTPMethod': 'POST', 'WFHTTPBodyType': 'File', 'ShowHeaders': True,
         'WFURL': token_string([url_att, '/api/upload?folder=', attach_out(u_folder, 'URL Encoded Text'),
                                '&name=', attach_out(u_ename, 'URL Encoded Text')]),
         'WFHTTPHeaders': auth_header(tok_att),
         'WFRequestVariable': token_attachment(repeat_item)}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.repeat.each',
     'WFWorkflowActionParameters': {'UUID': u_end, 'GroupingIdentifier': gid, 'WFControlFlowMode': 2}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.notification',
     'WFWorkflowActionParameters': {'WFNotificationActionTitle': 'Photos', 'WFNotificationActionBody': 'Upload finished'}},
]

shortcut = {
    'WFWorkflowClientVersion': '2605.0.5',
    'WFWorkflowMinimumClientVersion': 900,
    'WFWorkflowMinimumClientVersionString': '900',
    'WFWorkflowIcon': {'WFWorkflowIconStartColor': 4282601983, 'WFWorkflowIconGlyphNumber': 59511},
    'WFWorkflowTypes': ['ActionExtension'],
    'WFWorkflowInputContentItemClasses': ['WFImageContentItem', 'WFAVAssetContentItem', 'WFGenericFileContentItem'],
    'WFWorkflowImportQuestions': [
        {'ParameterKey': 'WFTextActionText', 'Category': 'Parameter', 'ActionIndex': 0,
         'Text': 'Your server address (e.g. https://photos.example.com, no trailing slash)',
         'DefaultValue': 'https://photos.example.com'},
        {'ParameterKey': 'WFTextActionText', 'Category': 'Parameter', 'ActionIndex': 1,
         'Text': 'Your API token (Photos app > avatar > Account > Generate token)',
         'DefaultValue': 'pu_paste_your_token_here'},
    ],
    'WFWorkflowActions': actions,
}

with open(sys.argv[1], 'wb') as f:
    plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
print('wrote', sys.argv[1])
